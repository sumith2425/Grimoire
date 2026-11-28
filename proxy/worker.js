// Grimoire relay: forwards read-only WordPress.com API requests for the configured translator sites
// and adds the CORS header browsers need. Used only when the browser can't reach WordPress directly
// (e.g. WordPress's bot check challenges the reader's browser).
//
// Deploy: Cloudflare dashboard → Workers & Pages → Create → Worker → paste this file → Deploy.
// Keep ALLOWED_SITES in sync with the siteDomain values in novels.json.

const ALLOWED_SITES = new Set([
    "blackseatls.wordpress.com",
    "babayaga017.wordpress.com",
    "punisher877.wordpress.com",
    "betterdaystranslations.wordpress.com",
    "shalvationtranslations.wordpress.com",
    "bettertranslation9.wordpress.com"
]);

const UPSTREAM = "https://public-api.wordpress.com/rest/v1.1";
const CACHE_SECONDS = 600;
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
};

function reply(body, status) {
    return new Response(body, { status, headers: { ...CORS_HEADERS, "Content-Type": "text/plain" } });
}

export default {
    async fetch(request, env, ctx) {
        if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
        if (request.method !== "GET") return reply("Method not allowed", 405);

        const url = new URL(request.url);
        // Only /sites/{site}/posts/... is relayed, so this can't be used as an open proxy.
        const match = url.pathname.match(/^\/sites\/([^/]+)\/posts\/?(.*)$/);
        if (!match || !ALLOWED_SITES.has(match[1])) return reply("Not found", 404);

        const target = `${UPSTREAM}/sites/${match[1]}/posts/${match[2]}${url.search}`;
        const cacheKey = new Request(target);
        const cache = caches.default;

        let response = await cache.match(cacheKey);
        if (!response) {
            const upstream = await fetch(target, { headers: { Accept: "application/json" } });
            response = new Response(upstream.body, upstream);
            if (upstream.ok) {
                response.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
                ctx.waitUntil(cache.put(cacheKey, response.clone()));
            }
        }

        response = new Response(response.body, response);
        for (const [key, value] of Object.entries(CORS_HEADERS)) response.headers.set(key, value);
        response.headers.delete("Set-Cookie");
        return response;
    }
};
