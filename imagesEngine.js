self.addEventListener('fetch', (event) => {
  try {
    const url = new URL(event.request.url);

    // If the requested URL is for a specific script or resource, respond with a special handling function
    if (
      url.pathname === '/cdn-cgi/zaraz/s.js' ||
      url.pathname === '/cdn-cgi/zaraz/t'
    ) {
      event.respondWith(fetchSpecialURL(event.request));
      return;
    };

    // If the requested URL ends with an image file extension, fetch it from a specific image engine
    if (
      url.pathname.match(/\.(gif|png|jpg|jpeg|webp|bmp|ico)$/i)
    ) {
      event.respondWith(fetchFromImageEngine(event.request));
      return;
    };

    // For any other request, handle it normally
    event.respondWith(handleRequest(event.request));
  } catch (e) {
    // Log any errors that occur during request handling
    console.log('Error:', e);
    event.respondWith(handleRequest(event.request));
  };
});

// Function to fetch images from a specific image engine with specified settings
async function fetchFromImageEngine(request) {
  const url = new URL(request.url);
  url.host = 'niezleziolko.app';
  url.protocol = 'https:';

  try {
    const newRequest = new Request(url, request);
    const response = await fetch(newRequest, {
      cf: {
        cacheTtl: 31536000,
        polish: 'lossy',
        mirage: true
      }
    });

    // Return the fetched image response
    return response;
  } catch (error) {
    // Log and handle errors that occur during image fetching
    console.log('Error fetching image:', error);
    return new Response(null, { status: 404 }); // Return a 404 response if fetching fails
  };
};

// Function to fetch a resource with specified cache control settings
async function fetchWithCacheControl(request, maxAgeSeconds) {
  try {
    const response = await fetch(request);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', `max-age=${maxAgeSeconds}`);

    // Return the response with updated cache control headers
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: headers
    });
  } catch (error) {
    // Log and handle errors that occur during resource fetching
    console.log('Error fetching resource:', error);
    return new Response(null, { status: 404 }); // Return a 404 response if fetching fails
  };
};

// Function to fetch a special URL
async function fetchSpecialURL(request) {
  const response = await fetch(request);

  // Return the fetched response
  return response;
};

// Function to handle any other type of request
async function handleRequest(request) {
  console.log('Request:', request); // Log the request
  const response = await fetch(request);
  console.log('Response:', response); // Log the response

  // Return the response
  return response;
};