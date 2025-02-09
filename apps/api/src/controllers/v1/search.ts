import { Response } from "express";
import { logger } from "../../lib/logger";
import {
  Document,
  RequestWithAuth,
  SearchRequest,
  SearchResponse,
  searchRequestSchema,
  ScrapeOptions,
} from "./types";
import { billTeam } from "../../services/billing/credit_billing";
import { v4 as uuidv4 } from "uuid";
import { addScrapeJob, waitForJob } from "../../services/queue-jobs";
import { logJob } from "../../services/logging/log_job";
import { getJobPriority } from "../../lib/job-priority";
import { PlanType, Mode } from "../../types";
import { getScrapeQueue } from "../../services/queue-service";
import { search } from "../../search";
import { isUrlBlocked } from "../../scraper/WebScraper/utils/blocklist";
import * as Sentry from "@sentry/node";
import { BLOCKLISTED_URL_MESSAGE } from "../../lib/strings";

/**
 * Attempts to scrape a search result. In case of error, returns a minimal Document
 * with metadata describing the error.
 */
async function scrapeSearchResult(
  searchResult: { url: string; title: string; description: string },
  options: {
    teamId: string;
    plan: PlanType | undefined;
    origin: string;
    timeout: number;
    scrapeOptions: ScrapeOptions;
  }
): Promise<Document> {
  const jobId = uuidv4();
  const jobPriority = await getJobPriority({
    plan: options.plan as PlanType,
    team_id: options.teamId,
    basePriority: 10,
  });

  try {
    if (isUrlBlocked(searchResult.url)) {
      throw new Error("Could not scrape url: " + BLOCKLISTED_URL_MESSAGE);
    }
    await addScrapeJob(
      {
        url: searchResult.url,
        mode: "single_urls" as Mode,
        team_id: options.teamId,
        scrapeOptions: options.scrapeOptions,
        internalOptions: {},
        plan: options.plan || "free",
        origin: options.origin,
        is_scrape: true,
      },
      {},
      jobId,
      jobPriority
    );

    const doc = await waitForJob<Document>(jobId, options.timeout);
    await getScrapeQueue().remove(jobId);

    // Merge the SERP result fields to the scraped document.
    return {
      title: searchResult.title,
      description: searchResult.description,
      url: searchResult.url,
      ...doc,
    };
  } catch (error: any) {
    // Ensure we have a valid string error message.
    const errorMessage = error && error.message ? error.message : String(error);
    logger.error(`Error in scrapeSearchResult: ${errorMessage}`, {
      url: searchResult.url,
      teamId: options.teamId,
    });

    let statusCode = 0;
    if (errorMessage.includes("Could not scrape url")) {
      statusCode = 403;
    }

    // Return a minimal document including the error info.
    return {
      title: searchResult.title,
      description: searchResult.description,
      url: searchResult.url,
      metadata: {
        statusCode,
        error: errorMessage,
      },
    };
  }
}

/**
 * Controller for handling search requests.
 */
export async function searchController(
  req: RequestWithAuth<{}, SearchResponse, SearchRequest>,
  res: Response<SearchResponse>
) {
  try {
    req.body = searchRequestSchema.parse(req.body);

    const jobId = uuidv4();
    const startTime = new Date().getTime();

    let limit = req.body.limit;
    // Buffer results by 50% to account for filtered URLs.
    const num_results_buffer = Math.floor(limit * 1.5);

    let searchResults = await search({
      query: req.body.query,
      advanced: false,
      num_results: num_results_buffer,
      tbs: req.body.tbs,
      filter: req.body.filter,
      lang: req.body.lang,
      country: req.body.country,
      location: req.body.location,
    });

    // Slice results down to the requested limit.
    if (searchResults.length > limit) {
      searchResults = searchResults.slice(0, limit);
    }

    if (searchResults.length === 0) {
      return res.status(200).json({
        success: true,
        data: [],
        warning: "No search results found",
      });
    }

    // If no scraping formats are requested, simply bill and return the SERP data.
    if (
      !req.body.scrapeOptions.formats ||
      req.body.scrapeOptions.formats.length === 0
    ) {
      billTeam(req.auth.team_id, req.acuc?.sub_id, searchResults.length).catch(
        (error) => {
          logger.error(
            `Failed to bill team ${req.auth.team_id} for ${searchResults.length} credits: ${error}`
          );
        }
      );
      return res.status(200).json({
        success: true,
        data: searchResults.map((r) => ({
          url: r.url,
          title: r.title,
          description: r.description,
        })) as Document[],
      });
    }

    // Scrape each search result.
    const scrapePromises = searchResults.map((result) =>
      scrapeSearchResult(result, {
        teamId: req.auth.team_id,
        plan: req.auth.plan,
        origin: req.body.origin,
        timeout: req.body.timeout,
        scrapeOptions: req.body.scrapeOptions,
      })
    );

    const docs = await Promise.all(scrapePromises);

    // Bill for the successfully scraped results.
    billTeam(req.auth.team_id, req.acuc?.sub_id, docs.length).catch((error) => {
      logger.error(
        `Failed to bill team ${req.auth.team_id} for ${docs.length} credits: ${error}`
      );
    });

    // Filter out documents with empty content (unless SERP results exist).
    const filteredDocs = docs.filter(
      (doc) =>
        doc.serpResults ||
        (doc.markdown && doc.markdown.trim().length > 0)
    );

    if (filteredDocs.length === 0) {
      return res.status(200).json({
        success: true,
        data: docs,
        warning: "No content found in search results",
      });
    }

    const endTime = new Date().getTime();
    const timeTakenInSeconds = (endTime - startTime) / 1000;

    logJob({
      job_id: jobId,
      success: true,
      num_docs: filteredDocs.length,
      docs: filteredDocs,
      time_taken: timeTakenInSeconds,
      team_id: req.auth.team_id,
      mode: "search",
      url: req.body.query,
      origin: req.body.origin,
    });

    return res.status(200).json({
      success: true,
      data: filteredDocs,
    });
  } catch (error: any) {
    const errorMessage = error && error.message ? error.message : String(error);
    // Handle timeout-specific errors.
    if (
      errorMessage.startsWith("Job wait") ||
      errorMessage === "timeout"
    ) {
      return res.status(408).json({
        success: false,
        error: "Request timed out",
      });
    }

    Sentry.captureException(error);
    logger.error("Unhandled error occurred in search", { error: errorMessage });
    return res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
}

