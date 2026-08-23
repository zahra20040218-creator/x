import { describe, expect, it } from 'vitest';

import { Counter, Histogram, LATENCY_BUCKETS, MetricsRegistry } from './metrics.js';

/**
 * The failure mode worth testing here is a metric that is WRONG rather than
 * missing. A missing metric is obvious the first time someone opens the
 * dashboard; a histogram whose buckets are not cumulative produces a p95 that
 * looks plausible and is not, and nobody discovers that during an incident.
 */

describe('Counter', () => {
  it('accumulates', () => {
    const counter = new Counter('c', 'help');
    counter.inc();
    counter.inc({}, 5);
    expect(counter.get()).toBe(6);
  });

  it('keeps label combinations apart', () => {
    const counter = new Counter('c', 'help', ['by']);
    counter.inc({ by: 'rider' });
    counter.inc({ by: 'rider' });
    counter.inc({ by: 'driver' });

    expect(counter.get({ by: 'rider' })).toBe(2);
    expect(counter.get({ by: 'driver' })).toBe(1);
  });

  it('treats label order as irrelevant', () => {
    // Two series that never add up is the classic way a dashboard undercounts
    // by half without anyone noticing.
    const counter = new Counter('c', 'help', ['a', 'b']);
    counter.inc({ a: '1', b: '2' });
    counter.inc({ b: '2', a: '1' });

    expect(counter.get({ a: '1', b: '2' })).toBe(2);
  });

  it('renders the exposition format', () => {
    const counter = new Counter('rides_total', 'Rides.', ['status']);
    counter.inc({ status: 'ok' }, 3);

    expect(counter.render()).toEqual([
      '# HELP rides_total Rides.',
      '# TYPE rides_total counter',
      'rides_total{status="ok"} 3',
    ]);
  });

  it('escapes quotes in label values', () => {
    // An unescaped quote produces a line Prometheus rejects, and the whole
    // scrape fails - not just that one metric.
    const counter = new Counter('c', 'help', ['route']);
    counter.inc({ route: 'a"b' });

    expect(counter.render().at(-1)).toBe('c{route="a\\"b"} 1');
  });
});

describe('Histogram', () => {
  it('is cumulative, as the format requires', () => {
    const histogram = new Histogram('h', 'help', [], [1, 2, 5]);
    histogram.observe(0.5);

    const rendered = histogram.render().join('\n');

    // 0.5 falls in every bucket at or above it, not only the smallest.
    expect(rendered).toContain('h_bucket{le="1"} 1');
    expect(rendered).toContain('h_bucket{le="2"} 1');
    expect(rendered).toContain('h_bucket{le="5"} 1');
  });

  it('counts a value above every bucket only in +Inf', () => {
    const histogram = new Histogram('h', 'help', [], [1, 2]);
    histogram.observe(99);

    const rendered = histogram.render().join('\n');
    expect(rendered).toContain('h_bucket{le="1"} 0');
    expect(rendered).toContain('h_bucket{le="2"} 0');
    expect(rendered).toContain('h_bucket{le="+Inf"} 1');
  });

  it('tracks sum and count', () => {
    const histogram = new Histogram('h', 'help');
    histogram.observe(0.1);
    histogram.observe(0.3);

    const rendered = histogram.render().join('\n');
    expect(rendered).toContain('h_sum 0.4');
    expect(rendered).toContain('h_count 2');
  });

  it('has a bucket exactly at the 200ms target', () => {
    // CLAUDE.md §3 asks for p95 < 200ms. Without a bound at 0.2 that question
    // can only be answered by interpolating between buckets, which is exactly
    // the kind of "roughly" a latency target is meant to eliminate.
    expect(LATENCY_BUCKETS).toContain(0.2);
  });
});

describe('MetricsRegistry', () => {
  it('renders every metric, including ones never touched', () => {
    const registry = new MetricsRegistry();
    const output = registry.render();

    // A metric that only appears after its first event makes a dashboard show
    // "no data" for a counter that is legitimately zero, which reads as broken
    // instrumentation rather than as "no rides were cancelled".
    for (const name of [
      'http_requests_total',
      'http_request_duration_seconds',
      'rides_requested_total',
      'rides_no_driver_total',
      'push_failed_total',
      'ratelimit_degraded_total',
      'dependency_errors_total',
    ]) {
      expect(output).toContain(`# HELP ${name} `);
    }
  });

  it('ends with a newline, which the format requires', () => {
    expect(new MetricsRegistry().render().endsWith('\n')).toBe(true);
  });

  it('exposes business metrics, not only technical ones', () => {
    const registry = new MetricsRegistry();
    registry.ridesRequested.inc();
    registry.ridesNoDriver.inc();

    const output = registry.render();

    // "Requests are 200 and latency is fine" is entirely compatible with "no
    // ride has been matched for an hour". These are the metrics that catch
    // the second one.
    expect(output).toContain('rides_requested_total 1');
    expect(output).toContain('rides_no_driver_total 1');
  });
});
