import axios from "axios"; // Adjust this import if needed
import { SearchResult } from "../../src/lib/entities";

// Round-robin index
let currentKeyIndex = 0;

/**
 * Collects up to 10 Google API keys:
 *   GOOGLE_API_KEY, GOOGLE_API_KEY2, ..., GOOGLE_API_KEY10
 *
 * Any undefined or empty values are filtered out.
 */
function getAllApiKeys(): string[] {
  const keys: string[] = [];

  if (process.env.GOOGLE_API_KEY)   keys.push(process.env.GOOGLE_API_KEY);
  if (process.env.GOOGLE_API_KEY2)  keys.push(process.env.GOOGLE_API_KEY2);
  if (process.env.GOOGLE_API_KEY3)  keys.push(process.env.GOOGLE_API_KEY3);
  if (process.env.GOOGLE_API_KEY4)  keys.push(process.env.GOOGLE_API_KEY4);
  if (process.env.GOOGLE_API_KEY5)  keys.push(process.env.GOOGLE_API_KEY5);
  if (process.env.GOOGLE_API_KEY6)  keys.push(process.env.GOOGLE_API_KEY6);
  if (process.env.GOOGLE_API_KEY7)  keys.push(process.env.GOOGLE_API_KEY7);
  if (process.env.GOOGLE_API_KEY8)  keys.push(process.env.GOOGLE_API_KEY8);
  if (process.env.GOOGLE_API_KEY9)  keys.push(process.env.GOOGLE_API_KEY9);
  if (process.env.GOOGLE_API_KEY10) keys.push(process.env.GOOGLE_API_KEY10);

  // Filter out any empty strings/spaces
  return keys.filter((k) => k.trim() !== "");
}

/**
 * Gets the current key from the array and advances the index (round-robin).
 */
function getNextApiKey(googleApiKeys: string[]): string {
  if (googleApiKeys.length === 0) {
    throw new Error("No Google API keys found in environment variables!");
  }
  const key = googleApiKeys[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % googleApiKeys.length;
  return key;
}

/**
 * Queries Google's Custom Search JSON API, rotating to the next key if
 * we get HTTP 400, 403, or 429. Logs which key is used for debugging,
 * plus success info and full response items.
 */
export async function googleCustomSearch(
  query: string,
  options: { num_results?: number } = {}
): Promise<SearchResult[]> {
  const { num_results = 5 } = options;

  const googleApiKeys = getAllApiKeys();
  const cseId = process.env.GOOGLE_CSE_ID;

  if (!cseId) {
    throw new Error("Missing GOOGLE_CSE_ID environment variable.");
  }
  if (googleApiKeys.length === 0) {
    throw new Error("No valid GOOGLE_API_KEY environment variables found.");
  }

  let lastError: any = null;

  // Try each key at most once
  for (let i = 0; i < googleApiKeys.length; i++) {
    const apiKey = getNextApiKey(googleApiKeys);

    const params = {
      key: apiKey,
      cx: cseId,
      q: query,
      num: num_results, // 1–10
    };

    try {
      console.log(
        `Using Google API key ending with "${apiKey.slice(-6)}" for query: "${query}"`
      );
      const response = await axios.get(
        "https://customsearch.googleapis.com/customsearch/v1",
        { params }
      );
      const items = response.data.items || [];

      // Map response to SearchResult
      const results: SearchResult[] = items.map((item: any) => {
        return new SearchResult(
          item.link ?? "",
          item.title ?? "",
          item.snippet ?? ""
        );
      });

      // Log success and the number of items returned
      console.debug(
        `[googleCustomSearch] Key ending "${apiKey.slice(-6)}" returned ${results.length} results.`
      );

      // If you'd like, log the full response items (can be large)
      console.debug(
        `[googleCustomSearch] Full response items:\n${JSON.stringify(items, null, 2)}`
      );

      return results;
    } catch (error: any) {
      const status = error.response?.status;
      const data = error.response?.data;

      // Decide which statuses to keep trying the next key for
      if (status === 400 || status === 403 || status === 429) {
        let reason = "";
        if (data?.error?.errors?.length) {
          reason = data.error.errors[0].reason || "";
        }
        console.warn(
          `Got HTTP ${status} from Google CSE with key ending in "${apiKey.slice(-6)}". Reason: ${reason}`
        );
        console.warn("Trying next key...");
        lastError = error;
        continue; // move to next key
      } else {
        // For any other error, stop and throw
        throw new Error(`Error calling Google Custom Search: ${error.message}`);
      }
    }
  }

  // If we used up all keys, throw the final error
  const status = lastError?.response?.status;
  const errMsg = lastError?.message || "Unknown error";
  throw new Error(
    `All Google CSE keys exhausted. Last error code: ${status}, message: ${errMsg}`
  );
}

