// Auto-Bot — optional bounded performance profiler.
//
// The profiler is deliberately off by default. When disabled, the hot path
// returns before calling performance.now(), allocating a profile context, or
// touching the rolling sample buffers. When enabled, it keeps only a bounded
// window so a long game cannot turn diagnostics into a new performance problem.

"use strict";

  const AUTO_BOT_PROFILE_WINDOW = 120;

  function createAutoBotProfileState() {
    return {
      windowSize: AUTO_BOT_PROFILE_WINDOW,
      sampledTicks: 0,
      lastTickMs: 0,
      maxTickMs: 0,
      slowTicks: 0,
      _tickSamples: [],
      _tickNext: 0,
      phases: Object.create(null),
      lastPhases: [],
    };
  }

  function getAutoBotProfileState() {
    if (!state.performanceProfile) {
      state.performanceProfile = createAutoBotProfileState();
    }
    return state.performanceProfile;
  }

  function autoBotProfilingEnabled() {
    return Boolean(state.settings && state.settings.performanceProfiling === true);
  }

  function autoBotProfileNow() {
    if (
      typeof window !== "undefined" &&
      typeof window.__OFH_deadlineNow === "function"
    ) {
      return Number(window.__OFH_deadlineNow());
    }
    return performance.now();
  }

  function beginAutoBotProfileTick() {
    if (!autoBotProfilingEnabled()) return null;
    return {
      startedAt: autoBotProfileNow(),
      phases: Object.create(null),
    };
  }

  function autoBotProfileStartPhase(profile) {
    return profile ? autoBotProfileNow() : 0;
  }

  function autoBotProfileEndPhase(profile, name, startedAt) {
    if (!profile) return;
    const elapsed = Math.max(0, autoBotProfileNow() - startedAt);
    profile.phases[name] = (profile.phases[name] || 0) + elapsed;
  }

  // These wrappers preserve the direct call path while profiling is disabled.
  // They are used only around already-expensive decision phases when enabled.
  function autoBotProfileSyncPhase(profile, name, fn) {
    if (!profile) return fn();
    const startedAt = autoBotProfileNow();
    try {
      return fn();
    } finally {
      autoBotProfileEndPhase(profile, name, startedAt);
    }
  }

  function autoBotProfileAsyncPhase(profile, name, fn) {
    if (!profile) return fn();
    const startedAt = autoBotProfileNow();
    let result;
    {
      result = fn();
    }
    const syncFinishedAt = autoBotProfileNow();
    autoBotProfileEndPhase(profile, `${name}-sync`, startedAt);
    return Promise.resolve(result).then(
      (value) => {
        autoBotProfileEndPhase(profile, `${name}-await`, syncFinishedAt);
        autoBotProfileEndPhase(profile, name, startedAt);
        return value;
      },
      (error) => {
        autoBotProfileEndPhase(profile, `${name}-await`, syncFinishedAt);
        autoBotProfileEndPhase(profile, name, startedAt);
        throw error;
      },
    );
  }

  function appendAutoBotProfileSample(bucket, value, windowSize) {
    if (!bucket.samples) {
      bucket.samples = [];
      bucket.next = 0;
    }
    if (bucket.samples.length < windowSize) {
      bucket.samples.push(value);
      return;
    }
    bucket.samples[bucket.next] = value;
    bucket.next = (bucket.next + 1) % windowSize;
  }

  function recordAutoBotProfileBucket(data, name, value) {
    let bucket = data.phases[name];
    if (!bucket) {
      bucket = data.phases[name] = {
        count: 0,
        totalMs: 0,
        maxMs: 0,
        samples: [],
        next: 0,
      };
    }
    bucket.count += 1;
    bucket.totalMs += value;
    bucket.maxMs = Math.max(bucket.maxMs, value);
    appendAutoBotProfileSample(bucket, value, data.windowSize);
  }

  function autoBotProfileSlowThresholdMs() {
    const configured = Number(
      state.tickIntervalMs || (state.settings && state.settings.tickMs) || 200,
    );
    return Math.max(100, Number.isFinite(configured) ? configured * 2 : 400);
  }

  function finishAutoBotProfileTick(profile) {
    if (!profile) return;
    const data = getAutoBotProfileState();
    const elapsed = Math.max(0, autoBotProfileNow() - profile.startedAt);
    data.sampledTicks += 1;
    data.lastTickMs = elapsed;
    data.maxTickMs = Math.max(data.maxTickMs, elapsed);
    if (elapsed >= autoBotProfileSlowThresholdMs()) data.slowTicks += 1;
    if (data._tickSamples.length < data.windowSize) {
      data._tickSamples.push(elapsed);
    } else {
      data._tickSamples[data._tickNext] = elapsed;
      data._tickNext = (data._tickNext + 1) % data.windowSize;
    }

    for (const [name, value] of Object.entries(profile.phases)) {
      recordAutoBotProfileBucket(data, name, value);
    }
    data.lastPhases = Object.entries(profile.phases)
      .map(([name, value]) => ({ name, ms: value }))
      .sort((a, b) => b.ms - a.ms);
  }

  function sortedAutoBotProfileSamples(samples) {
    return samples && samples.length > 0 ? [...samples].sort((a, b) => a - b) : [];
  }

  function autoBotProfilePercentile(samples, ratio) {
    const sorted = sortedAutoBotProfileSamples(samples);
    if (sorted.length === 0) return 0;
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(sorted.length * ratio) - 1),
    );
    return sorted[index];
  }

  function autoBotProfileRow(name, bucket) {
    return {
      name,
      count: bucket.count,
      avgMs: bucket.count > 0 ? bucket.totalMs / bucket.count : 0,
      p95Ms: autoBotProfilePercentile(bucket.samples, 0.95),
      maxMs: bucket.maxMs,
    };
  }

  function getAutoBotProfileSnapshot() {
    const data = state.performanceProfile;
    const tickSamples = data
      ? (data._tickSamples || [])
      : [];
    const phases = data
      ? Object.entries(data.phases)
          .map(([name, bucket]) => autoBotProfileRow(name, bucket))
          .sort((a, b) => b.p95Ms - a.p95Ms || b.maxMs - a.maxMs)
      : [];
    return {
      enabled: autoBotProfilingEnabled(),
      windowSize: data ? data.windowSize : AUTO_BOT_PROFILE_WINDOW,
      sampledTicks: data ? data.sampledTicks : 0,
      lastTickMs: data ? data.lastTickMs : 0,
      p95TickMs: autoBotProfilePercentile(tickSamples, 0.95),
      maxTickMs: data ? data.maxTickMs : 0,
      slowTicks: data ? data.slowTicks : 0,
      slowThresholdMs: autoBotProfileSlowThresholdMs(),
      lastPhases: data ? data.lastPhases.slice() : [],
      phases,
    };
  }

  function resetAutoBotProfile() {
    state.performanceProfile = createAutoBotProfileState();
    if (typeof renderStatus === "function") renderStatus();
    return getAutoBotProfileSnapshot();
  }

  function setAutoBotProfiling(enabled) {
    state.settings.performanceProfiling = Boolean(enabled);
    if (typeof saveSettings === "function") saveSettings();
    if (typeof renderStatus === "function") renderStatus();
    return state.settings.performanceProfiling;
  }

  function formatAutoBotProfileMs(value) {
    if (!Number.isFinite(value)) return "0";
    const precision = value >= 10 ? 0 : 1;
    return value.toFixed(precision);
  }

  function formatAutoBotProfileStatus() {
    const snapshot = getAutoBotProfileSnapshot();
    if (!snapshot.enabled) return "Profiler: off";
    if (snapshot.sampledTicks === 0) return "Profiler: waiting for samples";
    const top = snapshot.phases
      .slice(0, 2)
      .map((phase) => `${phase.name} p95 ${formatAutoBotProfileMs(phase.p95Ms)}ms`)
      .join(" · ");
    const topSuffix = top ? ` · ${top}` : "";
    return `Profiler: last ${formatAutoBotProfileMs(snapshot.lastTickMs)}ms · p95 ${formatAutoBotProfileMs(snapshot.p95TickMs)}ms · max ${formatAutoBotProfileMs(snapshot.maxTickMs)}ms${topSuffix}`;
  }

  function printAutoBotProfile() {
    const snapshot = getAutoBotProfileSnapshot();
    runtimeDebugLog(snapshot.phases);
    return snapshot;
  }

  if (typeof globalThis === "object") {
    globalThis.__OFH_autoBotProfiler = {
      snapshot: getAutoBotProfileSnapshot,
      reset: resetAutoBotProfile,
      setEnabled: setAutoBotProfiling,
      print: printAutoBotProfile,
    };
  }
