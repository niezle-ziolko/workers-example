addEventListener('fetch', event => {
    event.passThroughOnException();
    if (event.request.method === 'GET') {
        const url = new URL(event.request.url);
        const accept = event.request.headers.get('Accept');
        if (url.pathname.startsWith('/niezleziolko.app/')) {
            event.respondWith(proxyRequest('https:/' + url.pathname + url.search, event.request));
        } else if (accept && (accept.indexOf('text/html') >= 0 || accept.indexOf('text/css') >= 0)) {
            if (url.pathname.startsWith('/niezleziolko.app/')) {
                event.respondWith(proxyStylesheet('https:/' + url.pathname + url.search, event.request));
            } else {
                event.respondWith(processRequest(event.request, event));
            }
        }
    }
});

const VALID_CHARSETS = ['utf-8', 'utf8', 'iso-8859-1', 'us-ascii'];

async function proxyRequest(url, request) {
    let init = {
        method: request.method,
        headers: {},
    };
    const proxyHeaders = ['Accept', 'Accept-Encoding', 'Accept-Language', 'Referer', 'User-Agent'];
    for (let name of proxyHeaders) {
        let value = request.headers.get(name);
        if (value) {
            init.headers[name] = value;
        }
    }
    const clientAddr = request.headers.get('cf-connecting-ip');
    if (clientAddr) {
        init.headers['X-Forwarded-For'] = clientAddr;
    }

    const response = await fetch(url, init);
    if (response) {
        const responseHeaders = [
            'Content-Type',
            'Cache-Control',
            'Expires',
            'Accept-Ranges',
            'Date',
            'Last-Modified',
            'ETag',
        ];
        let responseInit = {
            status: response.status,
            statusText: response.statusText,
            headers: {},
        };
        for (let name of responseHeaders) {
            let value = response.headers.get(name);
            if (value) {
                responseInit.headers[name] = value;
            }
        }

        responseInit.headers['X-Content-Type-Options'] = 'nosniff';
        const newResponse = new Response(response.body, responseInit);
        return newResponse;
    }

    return response;
}

async function proxyStylesheet(url, request) {
    let css = await fetchCSS(url, request);
    if (css) {
        const responseInit = {
            headers: {
                'Content-Type': 'text/css; charset=utf-8',
                'Cache-Control': 'private, max-age=86400, stale-while-revalidate=604800',
            },
        };
        const newResponse = new Response(css, responseInit);
        return newResponse;
    } else {
        return proxyRequest(url, request);
    }
}

async function processRequest(request, event) {
    const response = await fetch(request);
    if (response && response.status === 200) {
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.indexOf('text/html') !== -1) {
            return await processHtmlResponse(response, event.request, event);
        } else if (contentType && contentType.indexOf('text/css') !== -1) {
            return await processStylesheetResponse(response, event.request, event);
        }
    }

    return response;
}

async function processHtmlResponse(response, request, event) {

    const contentType = response.headers.get('content-type');
    const charsetRegex = /charset\s*=\s*([^\s;]+)/gim;
    const match = charsetRegex.exec(contentType);
    if (match !== null) {
        let charset = match[1].toLowerCase();
        if (!VALID_CHARSETS.includes(charset)) {
            return response;
        }
    }

    let embedStylesheet = true;
    let csp = response.headers.get('Content-Security-Policy');
    if (csp) {
        let ok = false;
        let cspRule = null;
        const styleRegex = /style-src[^;]*/gim;
        let match = styleRegex.exec(csp);
        if (match !== null) {
            cspRule = match[0];
        } else {
            const defaultRegex = /default-src[^;]*/gim;
            let match = defaultRegex.exec(csp);
            if (match !== null) {
                cspRule = match[0];
            }
        }
        if (cspRule !== null) {
            if (cspRule.indexOf("'unsafe-inline'") >= 0) {
                ok = true;
                embedStylesheet = true;
            } else if (cspRule.indexOf("'self'") >= 0) {
                ok = true;
                embedStylesheet = false;
            }
        }

        if (!ok) {
            return response;
        }
    }

    const { readable, writable } = new TransformStream();

    const newResponse = new Response(readable, response);

    modifyHtmlStream(response.body, writable, request, event, embedStylesheet);

    return newResponse;
}

async function processStylesheetResponse(response, request, event) {
    let body = response.body;
    try {
        body = await response.text();
        const fontCSSRegex =
            /@import\s*(url\s*)?[\('"\s]+((https?:)?\/\/niezleziolko.app\/static\/(Icons|BalsamiqSans)-[^'"\)]+)[\s'"\)]+\s*;/gim;
        let match = fontCSSRegex.exec(body);
        while (match !== null) {
            const matchString = match[0];
            // @ts-ignore
            const fontCSS = await fetchCSS(match[2], request, event);
            if (fontCSS.length) {
                body = body.split(matchString).join(fontCSS);
                fontCSSRegex.lastIndex -= matchString.length - fontCSS.length;
            }
            match = fontCSSRegex.exec(body);
        }
    } catch (e) {

    }

    const newResponse = new Response(body, response);

    return newResponse;
}

function chunkContainsInvalidCharset(chunk) {
    let invalid = false;

    const charsetRegex = /<\s*meta[^>]+charset\s*=\s*['"]([^'"]*)['"][^>]*>/gim;
    const charsetMatch = charsetRegex.exec(chunk);
    if (charsetMatch) {
        const docCharset = charsetMatch[1].toLowerCase();
        if (!VALID_CHARSETS.includes(docCharset)) {
            invalid = true;
        }
    }
    const contentTypeRegex = /<\s*meta[^>]+http-equiv\s*=\s*['"]\s*content-type[^>]*>/gim;
    const contentTypeMatch = contentTypeRegex.exec(chunk);
    if (contentTypeMatch) {
        const metaTag = contentTypeMatch[0];
        const metaRegex = /charset\s*=\s*([^\s"]*)/gim;
        const metaMatch = metaRegex.exec(metaTag);
        if (metaMatch) {
            const charset = metaMatch[1].toLowerCase();
            if (!VALID_CHARSETS.includes(charset)) {
                invalid = true;
            }
        }
    }
    return invalid;
}

async function modifyHtmlStream(readable, writable, request, event, embedStylesheet) {
    const reader = readable.getReader();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    // @ts-ignore
    let decoder = new TextDecoder('utf-8', { fatal: true });

    let firstChunk = true;
    let unsupportedCharset = false;

    let partial = '';
    let content = '';

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                if (partial.length) {
                    partial = await modifyHtmlChunk(partial, request, event, embedStylesheet);
                    await writer.write(encoder.encode(partial));
                    partial = '';
                }
                break;
            }

            let chunk = null;
            if (unsupportedCharset) {
                await writer.write(value);
                continue;
            } else {
                try {
                    chunk = decoder.decode(value, { stream: true });
                } catch (e) {
                    unsupportedCharset = true;
                    if (partial.length) {
                        await writer.write(encoder.encode(partial));
                        partial = '';
                    }
                    await writer.write(value);
                    continue;
                }
            }

            try {
                if (firstChunk) {
                    firstChunk = false;
                    if (chunkContainsInvalidCharset(chunk)) {
                        unsupportedCharset = true;
                        if (partial.length) {
                            await writer.write(encoder.encode(partial));
                            partial = '';
                        }
                        await writer.write(value);
                        continue;
                    }
                }

                content = partial + chunk;
                partial = '';

                const linkPos = content.lastIndexOf('<link');
                if (linkPos >= 0) {
                    const linkClose = content.indexOf('/>', linkPos);
                    if (linkClose === -1) {
                        partial = content.slice(linkPos);
                        content = content.slice(0, linkPos);
                    }
                }

                if (content.length) {
                    content = await modifyHtmlChunk(content, request, event, embedStylesheet);
                }
            } catch (e) {
            }
            if (content.length) {
                await writer.write(encoder.encode(content));
                content = '';
            }
        }
    } catch (e) {
    }

    try {
        await writer.close();
    } catch (e) {
    }
}

async function modifyHtmlChunk(content, request, event, embedStylesheet) {
    const fontCSSRegex =
        /<link\s+[^>]*href\s*=\s*['"]((https?:)?\/\/niezleziolko.app\/static\/(Icons|BalsamiqSans)-[^'"]+)[^>]*>/gim;
    let match = fontCSSRegex.exec(content);
    while (match !== null) {
        const matchString = match[0];
        if (matchString.indexOf('stylesheet') >= 0) {
            if (embedStylesheet) {
                // @ts-ignore
                const fontCSS = await fetchCSS(match[1], request, event);
                if (fontCSS.length) {
                    let mediaStr = '';
                    const mediaMatch = matchString.match(/media\s*=\s*['"][^'"]*['"]/gim);
                    if (mediaMatch) {
                        mediaStr = ' ' + mediaMatch[0];
                    }
                    let cssString = '<style' + mediaStr + '>\n';
                    cssString += fontCSS;
                    cssString += '\n</style>\n';
                    content = content.split(matchString).join(cssString);
                    fontCSSRegex.lastIndex -= matchString.length - cssString.length;
                }
            } else {
                let originalUrl = match[1];
                let startPos = originalUrl.indexOf('/niezleziolko.app');
                let newUrl = originalUrl.substr(startPos);
                let newString = matchString.split(originalUrl).join(newUrl);
                content = content.split(matchString).join(newString);
                fontCSSRegex.lastIndex -= matchString.length - newString.length;
            }
            match = fontCSSRegex.exec(content);
        }
    }

    return content;
}

var FONT_CACHE = {};

async function fetchCSS(url, request) {
    let fontCSS = '';
    if (url.startsWith('/')) url = 'https:' + url;
    const userAgent = request.headers.get('user-agent');
    const clientAddr = request.headers.get('cf-connecting-ip');
    const browser = getCacheKey(userAgent);
    const cacheKey = browser ? url + '&' + browser : url;
    const cacheKeyRequest = new Request(cacheKey);
    let cache = null;

    let foundInCache = false;
    if (cacheKey in FONT_CACHE) {
        fontCSS = FONT_CACHE[cacheKey];
        foundInCache = true;
    } else {
        try {
            cache = caches.default;
            let response = await cache.match(cacheKeyRequest);
            if (response) {
                fontCSS = await response.text();
                foundInCache = true;
            }
        } catch (e) {
        }
    }

    if (!foundInCache) {
        let headers = { Referer: request.url };
        if (browser) {
            headers['User-Agent'] = userAgent;
        } else {
            headers['User-Agent'] = 'Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 6.0; Trident/4.0)';
        }
        if (clientAddr) {
            headers['X-Forwarded-For'] = clientAddr;
        }

        try {
            const response = await fetch(url, { headers: headers });
            if (response && response.status === 200) {
                fontCSS = await response.text();
                fontCSS = fontCSS.replace(/(https?:)?\/\/niezle-ziolko\.eu\//, '/static/DYNAMIC_HASH_CONTAINER.woff');
                FONT_CACHE[cacheKey] = fontCSS;
                try {
                    if (cache) {
                        // @ts-ignore
                        const cacheResponse = new Response(fontCSS, { ttl: 86400 });
                        // @ts-ignore
                        event.waitUntil(cache.put(cacheKeyRequest, cacheResponse));
                    }
                } catch (e) {
                }
            }
        } catch (e) {
        }
    }

    return fontCSS;
}

function getCacheKey(userAgent) {
    let os = '';
    const osRegex = /^[^(]*\(\s*(\w+)/gim;
    let match = osRegex.exec(userAgent);
    if (match) {
        os = match[1];
    }
    let mobile = '';
    if (userAgent.match(/Mobile/gim)) {
        mobile = 'Mobile';
    }
    const edgeRegex = /\s+Edge\/(\d+)/gim;
    match = edgeRegex.exec(userAgent);
    if (match) {
        return 'Edge' + match[1] + os + mobile;
    }
    const chromeRegex = /\s+Chrome\/(\d+)/gim;
    match = chromeRegex.exec(userAgent);
    if (match) {
        return 'Chrome' + match[1] + os + mobile;
    }
    const webkitRegex = /\s+AppleWebKit\/(\d+)/gim;
    match = webkitRegex.exec(userAgent);
    if (match) {
        return 'WebKit' + match[1] + os + mobile;
    }
    const firefoxRegex = /\s+Firefox\/(\d+)/gim;
    match = firefoxRegex.exec(userAgent);
    if (match) {
        return 'Firefox' + match[1] + os + mobile;
    }

    return null;
};