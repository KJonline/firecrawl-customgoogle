import { Request, Response } from "express";
import {
  billTeam,
  checkTeamCredits,
} from "../../services/billing/credit_billing";
import { authenticateUser } from "../auth";
import { PlanType, RateLimiterMode } from "../../types";
import { logJob } from "../../services/logging/log_job";
import { PageOptions, SearchOptions } from "../../lib/entities";
import { search } from "../../search";
import { isUrlBlocked } from "../../scraper/WebScraper/utils/blocklist";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../../lib/logger";
import { getScrapeQueue, redisConnection } from "../../services/queue-service";
import { addScrapeJob, waitForJob } from "../../services/queue-jobs";
import * as Sentry from "@sentry/node";
import { getJobPriority } from "../../lib/job-priority";
import { Job } from "bullmq";
import {
  Document,
  fromLegacyCombo,
  fromLegacyScrapeOptions,
  toLegacyDocument,
} from "../v1/types";

/**
 * Helper function that performs the search, enqueues scraping jobs, waits for
 * their completion, and returns legacy-formatted documents.
 */
export async function searchHelper(
  jobId: string,
  req: Request,
  team_id: string,
  subscription_id: string | null | undefined,
  crawlerOptions: any,
  pageOptions: PageOptions,
  searchOptions: SearchOptions,
  plan: PlanType | undefined,
): Promise<{
  success: boolean;
  error?: string;
  data?: any;
  returnCode: number;
}> {
  const query = req.body.query;
  const advanced = false;
  if (!query) {
    return { success: false, error: "Query is required", returnCode: 400 };
  }

  const tbs = searchOptions.tbs ?? undefined;
  const filter = searchOptions.filter ?? undefined;
  let num_results = Math.min(searchOptions.limit ?? 7, 10);

  // For this specific team, force a single result.
  if (team_id === "d97c4ceb-290b-4957-8432-2b2a02727d95") {
    num_results = 1;
  }

  // Buffer results by 50%
  const num_results_buffer = Math.floor(num_results * 1.5);

  let res = await search({
    query: query,
    advanced: advanced,
    num_results: num_results_buffer,
    tbs: tbs,
    filter: filter,
    lang: searchOptions.lang ?? "en",
    country: searchOptions.country ?? "us",
    location: searchOptions.location,
  });

  const justSearch = pageOptions.fetchPageContent === false;
  const { scrapeOptions, internalOptions } = fromLegacyCombo(
    pageOptions,
    undefined,
    60000,
    crawlerOptions,
  );

  if (justSearch) {
    billTeam(team_id, subscription_id, res.length).catch((error) => {
      // Safely convert error to a string
      const errorMessage = error && error.message ? error.message : String(error);
      logger.error(
        `Failed to bill team ${team_id} for ${res.length} credits: ${errorMessage}`
      );
    });
    return { success: true, data: res, returnCode: 200 };
  }

  // Filter out blocked URLs and slice to the proper limit.
  res = res.filter((r) => !isUrlBlocked(r.url));
  if (res.length > num_results) {
    res = res.slice(0, num_results);
  }

  if (res.length === 0) {
    return { success: true, error: "No search results found", returnCode: 200 };
  }

  const jobPriority = await getJobPriority({ plan, team_id, basePriority: 20 });
  // Create a job for each URL (filtering out social media links is assumed to be done earlier)
  const jobDatas = res.map((x) => {
    const url = x.url;
    const uuid = uuidv4();
    return {
      name: uuid,
      data: {
        url,
        mode: "single_urls",
        team_id: team_id,
        scrapeOptions,
        internalOptions,
      },
      opts: {
        jobId: uuid,
        priority: jobPriority,
      },
    };
  });

  // Enqueue scraping jobs.
  for (const job of jobDatas) {
    await addScrapeJob(job.data as any, {}, job.opts.jobId, job.opts.priority);
  }

  // Wait for all scraping jobs to finish.
  const docs = (
    await Promise.all(
      jobDatas.map((x) => waitForJob<Document>(x.opts.jobId, 60000))
    )
  ).map((x) => toLegacyDocument(x, internalOptions));

  if (docs.length === 0) {
    return { success: true, error: "No search results found", returnCode: 200 };
  }

  const sq = getScrapeQueue();
  await Promise.all(jobDatas.map((x) => sq.remove(x.opts.jobId)));

  // Filter out documents with empty content.
  const filteredDocs = docs.filter(
    (doc: any) => doc && doc.content && doc.content.trim().length > 0
  );

  if (filteredDocs.length === 0) {
    return {
      success: true,
      error: "No page found",
      returnCode: 200,
      data: docs,
    };
  }

  return {
    success: true,
    data: filteredDocs,
    returnCode: 200,
  };
}

/**
 * Controller for handling legacy (v0) search requests.
 */
export async function searchController(req: Request, res: Response) {
  try {
    // Authenticate user (expects Bearer <token>)
    const auth = await authenticateUser(req, res, RateLimiterMode.Search);
    if (!auth.success) {
      return res.status(auth.status).json({ error: auth.error });
    }
    const { team_id, plan, chunk } = auth;

    redisConnection
      .sadd("teams_using_v0", team_id)
      .catch((error) => {
        const errorMessage =
          error && error.message ? error.message : String(error);
        logger.error("Failed to add team to teams_using_v0", { error: errorMessage, team_id });
      });

    const crawlerOptions = req.body.crawlerOptions ?? {};
    const pageOptions = req.body.pageOptions ?? {
      includeHtml: req.body.pageOptions?.includeHtml ?? false,
      onlyMainContent: req.body.pageOptions?.onlyMainContent ?? false,
      fetchPageContent: req.body.pageOptions?.fetchPageContent ?? true,
      removeTags: req.body.pageOptions?.removeTags ?? [],
      fallback: req.body.pageOptions?.fallback ?? false,
    };
    const origin = req.body.origin ?? "api";
    const searchOptions = req.body.searchOptions ?? { limit: 5 };

    const jobId = uuidv4();

    // Check billing credits
    try {
      const { success: creditsCheckSuccess } = await checkTeamCredits(
        chunk,
        team_id,
        1
      );
      if (!creditsCheckSuccess) {
        return res.status(402).json({ error: "Insufficient credits" });
      }
    } catch (error) {
      const errorMessage =
        error && error.message ? error.message : String(error);
      Sentry.captureException(error);
      logger.error(errorMessage);
      return res.status(500).json({ error: "Internal server error" });
    }

    const startTime = new Date().getTime();
    const result = await searchHelper(
      jobId,
      req,
      team_id,
      chunk?.sub_id,
      crawlerOptions,
      pageOptions,
      searchOptions,
      plan,
    );
    const endTime = new Date().getTime();
    const timeTakenInSeconds = (endTime - startTime) / 1000;
    logJob({
      job_id: jobId,
      success: result.success,
      message: result.error,
      num_docs: result.data ? result.data.length : 0,
      docs: result.data,
      time_taken: timeTakenInSeconds,
      team_id: team_id,
      mode: "search",
      url: req.body.query,
      crawlerOptions: crawlerOptions,
      origin: origin,
    });
    return res.status(result.returnCode).json(result);
  } catch (error: any) {
    // Safely extract the error message.
    const errorMessage =
      error && error.message ? error.message : String(error);
    if (errorMessage.startsWith("Job wait") || errorMessage === "timeout") {
      return res.status(408).json({ error: "Request timed out" });
    }
    Sentry.captureException(error);
    logger.error("Unhandled error occurred in search", { error: errorMessage });
    return res.status(500).json({ error: errorMessage });
  }
}

