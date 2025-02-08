import { logger } from "../../src/lib/logger";
import { SearchResult } from "../../src/lib/entities";

// Existing imports for raw scraping, Serper, and SearchAPI
import { googleSearch } from "./googlesearch";
import { serper_search } from "./serper";
import { searchapi_search } from "./searchapi";

// New import for your Google Custom Search function
import { googleCustomSearch } from "./google_custom_search";

/**
 * search() decides which search provider to use:
 * 1) Your own Google API key (Custom Search JSON API)
 * 2) Serper
 * 3) SearchAPI
 * 4) Fallback to raw HTML scraping
 */
export async function search({
  query,
  advanced = false,
  num_results = 5,
  tbs = undefined,
  filter = undefined,
  lang = "en",
  country = "us",
  location = undefined,
  proxy = undefined,
  sleep_interval = 0,
  timeout = 5000,
}: {
  query: string;
  advanced?: boolean;
  num_results?: number;
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  proxy?: string;
  sleep_interval?: number;
  timeout?: number;
}): Promise<SearchResult[]> {
  try {
    // 1) If you have your own Google CSE credentials, use the official API
    if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_CSE_ID) {
      // googleCustomSearch only needs `query` and optionally `num_results`.
      // If you want to pass other parameters, you'd have to enhance google_custom_search.ts.
      return await googleCustomSearch(query, {
        num_results,
      });
    }

    // 2) If SERPER_API_KEY is set, call Serper
    if (process.env.SERPER_API_KEY) {
      return await serper_search(query, {
        num_results,
        tbs,
        filter,
        lang,
        country,
        location,
      });
    }

    // 3) If SEARCHAPI_API_KEY is set, call SearchAPI
    if (process.env.SEARCHAPI_API_KEY) {
      return await searchapi_search(query, {
        num_results,
        tbs,
        filter,
        lang,
        country,
        location,
      });
    }

    // 4) Fallback to raw scraping of Google
    // googleSearch expects up to 10 arguments: (query, advanced, num_results, tbs, filter, lang, country, proxy, sleep_interval, timeout)
    return await googleSearch(
      query,
      advanced,
      num_results,
      tbs,
      filter,
      lang,
      country,
      proxy,
      sleep_interval,
      timeout,
    );

  } catch (error) {
    logger.error(`Error in search function: ${error}`);
    return [];
  }
}

