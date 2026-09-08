import AggregateModel from "../../../../Types/BaseDatabase/AggregatedModel";
import InBetween from "../../../../Types/BaseDatabase/InBetween";
import AggregationIntervalUtil from "../../../../Types/BaseDatabase/AggregationIntervalUtil";
import BadDataException from "../../../../Types/Exception/BadDataException";
import { MetricMonitorOptions } from "../../../../Types/Monitor/CriteriaFilter";

/**
 * Select a complete window without inventing zeroes for absent samples.
 * Empty means insufficient evidence, and is handled by the caller's no-data
 * policy. A longer query lookback supplies the sample at the leading boundary.
 */
export default function selectMetricEvaluationWindow(
  samples: Array<AggregateModel>,
  window: MetricMonitorOptions["evaluationWindow"],
  queryWindow: InBetween<Date> | undefined,
): Array<AggregateModel> {
  if (!window) {
    return samples;
  }
  const end: Date | undefined = queryWindow?.endValue;
  if (
    !end ||
    !Number.isFinite(end.getTime()) ||
    !Number.isFinite(window.durationSeconds) ||
    window.durationSeconds <= 0 ||
    !Number.isFinite(window.maxBucketGapSeconds) ||
    window.maxBucketGapSeconds <= 0 ||
    window.maxBucketGapSeconds >= window.durationSeconds
  ) {
    throw new BadDataException(
      "Metric evaluation window needs an end time and a positive sample gap shorter than its duration.",
    );
  }
  const endMs: number = end.getTime();
  const startMs: number = endMs - window.durationSeconds * 1000;
  const gapMs: number = window.maxBucketGapSeconds * 1000;
  const bucketMs: number = AggregationIntervalUtil.getAggregationIntervalMs(
    AggregationIntervalUtil.getAggregationIntervalForWindow({
      startDate: queryWindow!.startValue,
      endDate: end,
    }),
  );
  if (
    bucketMs > gapMs ||
    endMs - queryWindow!.startValue.getTime() <
      window.durationSeconds * 1000 + bucketMs
  ) {
    throw new BadDataException(
      "Query lookback must include a boundary bucket and its resolution must fit the evaluation window's maximum bucket gap.",
    );
  }
  const ordered: Array<AggregateModel> = samples
    .filter((sample: AggregateModel) => {
      const timestamp: number = new Date(sample.timestamp).getTime();
      return (
        Number.isFinite(sample.value) &&
        timestamp <= endMs &&
        timestamp >= startMs - gapMs - bucketMs
      );
    })
    .sort((a: AggregateModel, b: AggregateModel) => {
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    });
  const boundary: AggregateModel | undefined = ordered
    .filter((sample: AggregateModel) => {
      /*
       * Bucket timestamps are starts: a reading at 00:59 is stamped 00:00.
       * Require its entire bucket to precede the start, avoiding early alerts.
       */
      return new Date(sample.timestamp).getTime() + bucketMs <= startMs;
    })
    .pop();
  if (!boundary) {
    return [];
  }
  const selected: Array<AggregateModel> = [
    boundary,
    ...ordered.filter((sample: AggregateModel) => {
      return (
        new Date(sample.timestamp).getTime() >
        new Date(boundary.timestamp).getTime()
      );
    }),
  ];
  let previousMs: number = new Date(boundary.timestamp).getTime();
  for (const sample of selected) {
    const timestamp: number = new Date(sample.timestamp).getTime();
    if (timestamp - previousMs > gapMs) {
      return [];
    }
    previousMs = timestamp;
  }
  return endMs - previousMs <= gapMs ? selected : [];
}
