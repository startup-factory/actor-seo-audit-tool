const Apify = require('apify');

const { log, enqueueLinks } = Apify.utils;
const { PseudoUrl } = Apify;

const { basicSEO } = require('./seo.js');
const { jsonLdLookup, microdataLookup } = require('./ontology_lookups.js');

Apify.main(async () => {
    const input = await Apify.getValue('INPUT')

//     const input = {
//   "startUrl": "https://loicginoux.com/",
//   "startUrls": [
//     {
//       "requestsFromUrl": "https://apify-uploads-prod.s3.amazonaws.com/da638uahgx8KhfEJS-seo_urls.tsv"
//     }
//   ],
//   "proxy": {
//     "useApifyProxy": true
//   },
//   "maxRequestsPerCrawl": 3,
//   "maxDepth": 3,
//   "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/84.0.4147.125 Safari/537.36",
//   "handlePageTimeoutSecs": 3600
// }
    const {
        startUrl,
        startUrls,
        proxy,
        maxRequestsPerCrawl,
        maxDepth,
        seoParams,
        userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/84.0.4147.125 Safari/537.36',
        viewPortWidth,
        viewPortHeight,
        pageTimeout,
        maxRequestRetries,
        handlePageTimeoutSecs = 3600,
    } = input;



    const proxyConfiguration = await Apify.createProxyConfiguration({
        ...proxy,
    }) || undefined;

    const requestQueue = await Apify.openRequestQueue();

    if (Array.isArray(startUrls) && startUrls.length > 0) {
      Apify.utils.log.warning('Search and directUrls are disabled when startUrls tsv file is used');
        for (const startUrl of startUrls) {
            Apify.utils.log.info(`startUrl: ${startUrl}`);
            if (startUrl){
              const {requestsFromUrl} = startUrl;
              Apify.utils.log.info(`requestsFromUrl: ${requestsFromUrl}`);
              if (requestsFromUrl){
                  const { body } = await Apify.utils.requestAsBrowser({ url: requestsFromUrl, encoding:'utf-8' });
                  let lines = body.split('\n');
                  delete  lines[0]
                  let requests = lines.map(line => {
                      let [id, url] = line.trim().split('\t');
                      if (!url) { return false }
                      log.info(`SEO audit for ${url} started`);

                      // Get web hostname
                      const { hostname } = new URL(url);
                      const pseudoUrl = new PseudoUrl(`[http|https]://[.*]${hostname}[.*]`);

                      log.info(`Web host name: ${hostname}`);

                      Apify.utils.log.info(`csv extraction: id: ${id} url ${url}`);
                      return {url, userData: {id, pseudoUrl}};
                  }).filter(req => !!req);

                  const addRequestToQueue = async request => {
                    return await requestQueue.addRequest(request)
                  }

                  const addAllRequests = async () => {
                    return Promise.all(requests.map(addRequestToQueue))
                  }
              }
            }
        }
    } else {
      log.info(`SEO audit for ${startUrl} started`);

      // Get web hostname
      const { hostname } = new URL(startUrl);
      const pseudoUrl = new PseudoUrl(`[http|https]://[.*]${hostname}[.*]`);

      log.info(`Web host name: ${hostname}`);

      await requestQueue.addRequest({ url: startUrl, userData: { pseudoUrl } });
    }


    const crawler = new Apify.PuppeteerCrawler({
        requestQueue,
        proxyConfiguration,
        useSessionPool: true,
        gotoFunction: async ({ request, page }) => {
            await page.setBypassCSP(true);

            if (userAgent) {
                await page.setUserAgent(userAgent);
            }

            if (viewPortWidth && viewPortHeight) {
                await page.setViewport({
                    height: viewPortHeight,
                    width: viewPortWidth,
                });
            }

            return page.goto(request.url, {
                waitUntil: 'networkidle2',
                timeout: pageTimeout,
            });
        },
        launchPuppeteerOptions: {
            ignoreHTTPSErrors: true,
            args: [
                // needed for CSP to be actually bypassed, and fetch work inside the browser
                '--allow-running-insecure-content',
                '--disable-web-security',
                '--enable-features=NetworkService',
                '--ignore-certificate-errors',
            ],
        },
        maxRequestRetries,
        maxRequestsPerCrawl,
        handlePageTimeoutSecs,
        handlePageFunction: async ({ request, page }) => {
            log.info('Start processing', { url: request.url });

            const data = {
                url: page.url(),
                title: await page.title(),
                // isLoaded: true,
                ...await basicSEO(page, seoParams),
                jsonLd: await jsonLdLookup(page),
                microdata: await microdataLookup(page),
            };

            await Apify.pushData(data);

            // Enqueue links, support SPAs
            const enqueueResults = await enqueueLinks({
                page,
                selector: 'a[href]:not([target="_blank"]),a[href]:not([rel*="nofollow"]),a[href]:not([rel*="noreferrer"])', // exclude externals
                pseudoUrls: [request.userData.pseudoUrl],
                requestQueue,
                transformRequestFunction: (r) => {
                    const url = new URL(r.url);
                    url.pathname = url.pathname
                        .split('/')
                        .filter(s => s)
                        .slice(0, maxDepth)
                        .join('/');

                    return {
                        url: url.toString(),
                    };
                },
            });

            const newRequests = enqueueResults.filter((result) => (!result.wasAlreadyPresent));

            if (newRequests.length) {
                log.info(`${request.url}: Added ${newRequests.length} urls to queue.`);
            }

            log.info(`${request.url}: Finished`);
        },

        handleFailedRequestFunction: async ({ request, error }) => {
            log.info(`Request ${request.url} failed too many times`);

            await Apify.pushData({
                url: request.url,
                isLoaded: false,
                errorMessage: error.message,
            });
        },
    });

    await crawler.run();

    log.info(`SEO audit finished.`);
});
