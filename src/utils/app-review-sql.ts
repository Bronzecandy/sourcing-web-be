/**
 * SQL fragments for AppReview — extract review text/score without full `raw` JSON.
 */

export const APP_REVIEW_TEXT_SQL = `COALESCE(
  raw->'review'->'contents'->>'text',
  raw->'sharing'->>'description'
)`;

export const APP_REVIEW_SCORE_SQL = `COALESCE((raw->'review'->>'score')::float, 0)`;

/** Lightweight row for AI review fetch / stratified sampling. */
export const APP_REVIEW_LIGHT_SELECT = `
  id,
  ${APP_REVIEW_TEXT_SQL} AS "reviewText",
  ${APP_REVIEW_SCORE_SQL} AS "reviewScore",
  "reviewAt"`;

/** Deterministic pseudo-random order — avoids expensive ORDER BY RANDOM(). */
export const APP_REVIEW_SAMPLE_ORDER_SQL = `abs(hashtextextended(id::text, 0))`;
