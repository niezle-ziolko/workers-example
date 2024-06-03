// @ts-nocheck
const CLOUDFLARE_API = {
  email: '',
  key: '',
  zone: ''
};

const DEFAULT_BYPASS_COOKIES = [
  'pushowl_visitor_token', 
  'react-use-cart', 
  /^@@auth0spajs@@.*$/,
  /^ecommerce_checkout_return_url_.*$/,
  /^_ga.*$/,
  '_uetsid',
  'SESS_7',
  '_clsk',
  '_gcl_au',
  'po_visitor'
];

addEventListener('fetch', event => {
    const request = event.request;
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.match(/^\/workbox-/) ||
        path.match(/^\/page-data/) ||
        path.match(/^\/offline-app-shell-/) ||
        path.match(/manifest\.webmanifest$/) ||
        path.match(/manifest_en\.webmanifest$/) ||
        path.match(/\/sw\.js$/)
        ) {
        event.respondWith(processNonCacheableRequest(request));
        return;
    }

    let upstreamCache = request.headers.get('x-HTML-Edge-Cache');

    let configured = false;
    // @ts-ignore
    if (typeof EDGE_CACHE !== 'undefined') {
        configured = true;
    } else if (
        CLOUDFLARE_API.email.length &&
        CLOUDFLARE_API.key.length &&
        CLOUDFLARE_API.zone.length
    ) {
        configured = true;
    };

    const accept = request.headers.get('Accept');
    const isImage = (url.pathname.endsWith('.webp') || url.pathname.endsWith('.png'));

    if (configured && accept && isImage && upstreamCache === null) {
        event.passThroughOnException();
        event.respondWith(processRequest(request, event));
    };
});

/**
 * @param {Request} request - Request
 * @returns {Response} - Response
 */
async function processNonCacheableRequest(request) {
    const response = await fetch(request);
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
    });
}

/**
 * @param {Request} originalRequest - Original request
 * @param {Event} event - Original event (for additional async waiting)
 */
async function processRequest(originalRequest, event) {
	let cfCacheStatus = null;
	const accept = originalRequest.headers.get('Accept');
	const isHTML = accept && accept.indexOf('text/html') >= 0;
	let { response, cacheVer, status, bypassCache } = await getCachedResponse(originalRequest);

	if (response === null) {
		let request = new Request(originalRequest);
		request.headers.set('x-HTML-Edge-Cache', 'supports=cache|purgeall|bypass-cookies');
		response = await fetch(request);

		if (response) {
			const options = getResponseOptions(response);
			if (options && options.purge) {
				await purgeCache(cacheVer, event);
				status += ', Purged';
			}
			bypassCache = bypassCache || shouldBypassEdgeCache(request, response);
			if (
				(!options || options.cache) &&
				isHTML &&
				originalRequest.method === 'GET' &&
				response.status === 200 &&
				!bypassCache
			) {
				status += await cacheResponse(cacheVer, originalRequest, response, event);
			}
		}
	} else {
		cfCacheStatus = 'HIT';
		if (originalRequest.method === 'GET' && response.status === 200 && isHTML) {
			bypassCache = bypassCache || shouldBypassEdgeCache(originalRequest, response);
			if (!bypassCache) {
				const options = getResponseOptions(response);
				if (!options) {
					status += ', Refreshed';
					// @ts-ignore
					event.waitUntil(updateCache(originalRequest, cacheVer, event));
				}
			}
		}
	}

	if (
		response &&
		status !== null &&
		originalRequest.method === 'GET' &&
		response.status === 200 &&
		isHTML
	) {
		response = new Response(response.body, response);
		response.headers.set('x-HTML-Edge-Cache-Status', status);
		if (cacheVer !== null) {
			response.headers.set('x-HTML-Edge-Cache-Version', cacheVer.toString());
		}
		if (cfCacheStatus) {
			response.headers.set('CF-Cache-Status', cfCacheStatus);
		};
	};

	return response;
};

/**
 * @param {Request} request - Request
 * @param {Response} response - Response
 * @returns {bool} true if the cache should be bypassed
 */
function shouldBypassEdgeCache(request, response) {
    let bypassCache = false;

    if (request && response) {
        const options = getResponseOptions(response);
        const cookieHeader = request.headers.get('cookie');
        let bypassCookies = DEFAULT_BYPASS_COOKIES;
        if (options) {
            bypassCookies = options.bypassCookies;
        }
        if (cookieHeader && cookieHeader.length && bypassCookies.length) {
            const cookies = cookieHeader.split(';');
            for (let cookie of cookies) {
                for (let prefix of bypassCookies) {
                    if (typeof prefix === 'string') {
                        if (cookie.trim().startsWith(prefix)) {
                            bypassCache = true;
                            break;
                        }
                    } else if (prefix instanceof RegExp) {
                        if (prefix.test(cookie.trim())) {
                            bypassCache = true;
                            break;
                        }
                    }
                }
                if (bypassCache) {
                    break;
                }
            }
        }
    }

    return bypassCache;
}

const CACHE_HEADERS = ['Cache-Control', 'Expires', 'Pragma'];

/**
 * Check for cached HTML GET requests.
 *
 * @param {Request} request - Original request
 */
async function getCachedResponse(request) {
	let response = null;
	let cacheVer = null;
	let bypassCache = false;
	let status = 'Miss';

	const accept = request.headers.get('Accept');
	const cacheControl = request.headers.get('Cache-Control');
	let noCache = false;
	if (cacheControl && cacheControl.indexOf('no-cache') !== -1) {
		noCache = true;
		status = 'Bypass for Reload';
	}
	if (!noCache && request.method === 'GET' && accept && accept.indexOf('text/html') >= 0) {
		cacheVer = await GetCurrentCacheVersion(cacheVer);
		const cacheKeyRequest = GenerateCacheRequest(request, cacheVer);
		try {
			let cache = caches.default;
			let cachedResponse = await cache.match(cacheKeyRequest);
			if (cachedResponse) {
				cachedResponse = new Response(cachedResponse.body, cachedResponse);

				bypassCache = shouldBypassEdgeCache(request, cachedResponse);

				if (bypassCache) {
					status = 'Bypass Cookie';
				} else {
					status = 'Hit';
					cachedResponse.headers.delete('Cache-Control');
					cachedResponse.headers.delete('x-HTML-Edge-Cache-Status');
					// @ts-ignore
					for (header of CACHE_HEADERS) {
						// @ts-ignore
						let value = cachedResponse.headers.get('x-HTML-Edge-Cache-Header-' + header);
						if (value) {
							// @ts-ignore
							cachedResponse.headers.delete('x-HTML-Edge-Cache-Header-' + header);
							// @ts-ignore
							cachedResponse.headers.set(header, value);
						}
					}
					response = cachedResponse;
				}
			} else {
				status = 'Miss';
			}
		} catch (err) {
			status = 'Cache Read Exception: ' + err.message;
		};
	};

	return { response, cacheVer, status, bypassCache };
};

/**
 * Asynchronously purge the HTML cache.
 * @param {Int} cacheVer - Current cache version (if retrieved)
 * @param {Event} event - Original event
 */
async function purgeCache(cacheVer, event) {
	// @ts-ignore
	if (typeof EDGE_CACHE !== 'undefined') {
		cacheVer = await GetCurrentCacheVersion(cacheVer);
		cacheVer++;
		// @ts-ignore
		event.waitUntil(EDGE_CACHE.put('html_cache_version', cacheVer.toString()));
	} else {
		const url =
			'https://api.cloudflare.com/client/v4/zones/' + CLOUDFLARE_API.zone + '/purge_cache';
		// @ts-ignore
		event.waitUntil(
			fetch(url, {
				method: 'POST',
				headers: {
					'X-Auth-Email': CLOUDFLARE_API.email,
					'X-Auth-Key': CLOUDFLARE_API.key,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ purge_everything: true }),
			})
		);
	};
};

/**
 * Update the cached copy of the given page
 * @param {Request} originalRequest - Original Request
 * @param {String} cacheVer - Cache Version
 * @param {EVent} event - Original event
 */
async function updateCache(originalRequest, cacheVer, event) {
	let request = new Request(originalRequest);
	request.headers.set('x-HTML-Edge-Cache', 'supports=cache|purgeall|bypass-cookies');
	// @ts-ignore
	response = await fetch(request);

	// @ts-ignore
	if (response) {
		// @ts-ignore
		status = ': Fetched';
		// @ts-ignore
		const options = getResponseOptions(response);
		if (options && options.purge) {
			await purgeCache(cacheVer, event);
		}
		// @ts-ignore
		let bypassCache = shouldBypassEdgeCache(request, response);
		if ((!options || options.cache) && !bypassCache) {
			// @ts-ignore
			await cacheResponse(cacheVer, originalRequest, response, event);
		}
	}
};

/**
 * Cache the returned content (but only if it was a successful GET request)
 *
 * @param {Int} cacheVer - Current cache version (if already retrieved)
 * @param {Request} request - Original Request
 * @param {Response} originalResponse - Response to (maybe) cache
 * @param {Event} event - Original event
 * @returns {bool} true if the response was cached
 */
async function cacheResponse(cacheVer, request, originalResponse, event) {
	let status = '';
	const accept = request.headers.get('Accept');
	if (
		request.method === 'GET' &&
		originalResponse.status === 200 &&
		accept &&
		accept.indexOf('text/html') >= 0
	) {
		cacheVer = await GetCurrentCacheVersion(cacheVer);
		const cacheKeyRequest = GenerateCacheRequest(request, cacheVer);

		try {
			let cache = caches.default;
			let clonedResponse = originalResponse.clone();
			let response = new Response(clonedResponse.body, clonedResponse);
			// @ts-ignore
			for (header of CACHE_HEADERS) {
				// @ts-ignore
				let value = response.headers.get(header);
				if (value) {
					// @ts-ignore
					response.headers.delete(header);
					// @ts-ignore
					response.headers.set('x-HTML-Edge-Cache-Header-' + header, value);
				}
			}
			response.headers.delete('Set-Cookie');
			response.headers.set('Cache-Control', 'public; max-age=315360000');
			// @ts-ignore
			event.waitUntil(cache.put(cacheKeyRequest, response));
			status = ', Cached';
		} catch (err) {
			// status = ", Cache Write Exception: " + err.message;
		}
	}
	return status;
};

/**
 * Parse the commands from the x-HTML-Edge-Cache response header.
 * @param {Response} response - HTTP response from the origin.
 * @returns {*} Parsed commands
 */
function getResponseOptions(response) {
	let options = null;
	let header = response.headers.get('x-HTML-Edge-Cache');
	if (header) {
		options = {
			purge: false,
			cache: false,
			bypassCookies: [],
		};
		let commands = header.split(',');
		for (let command of commands) {
			if (command.trim() === 'purgeall') {
				options.purge = true;
			} else if (command.trim() === 'cache') {
				options.cache = true;
			} else if (command.trim().startsWith('bypass-cookies')) {
				let separator = command.indexOf('=');
				if (separator >= 0) {
					let cookies = command.substr(separator + 1).split('|');
					for (let cookie of cookies) {
						cookie = cookie.trim();
						if (cookie.length) {
							options.bypassCookies.push(cookie);
						}
					}
				}
			}
		}
	}

	return options;
};

/**
 * Retrieve the current cache version from KV
 * @param {Int} cacheVer - Current cache version value if set.
 * @returns {Int} The current cache version.
 */
async function GetCurrentCacheVersion(cacheVer) {
	if (cacheVer === null) {
		// @ts-ignore
		if (typeof EDGE_CACHE !== 'undefined') {
			// @ts-ignore
			cacheVer = await EDGE_CACHE.get('html_cache_version');
			if (cacheVer === null) {
				cacheVer = 0;
				// @ts-ignore
				await EDGE_CACHE.put('html_cache_version', cacheVer.toString());
			} else {
				cacheVer = parseInt(cacheVer);
			}
		} else {
			cacheVer = -1;
		}
	}
	return cacheVer;
};

/**
 * Generate the versioned Request object to use for cache operations.
 * @param {Request} request - Base request
 * @param {Int} cacheVer - Current Cache version (must be set)
 * @returns {Request} Versioned request object
 */
function GenerateCacheRequest(request, cacheVer) {
	let cacheUrl = request.url;
	if (cacheUrl.indexOf('?') >= 0) {
		cacheUrl += '&';
	} else {
		cacheUrl += '?';
	}
	cacheUrl += 'cf_edge_cache_ver=' + cacheVer;
	return new Request(cacheUrl);
};