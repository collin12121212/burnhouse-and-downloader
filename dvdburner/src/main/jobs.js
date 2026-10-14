'use strict';

/**
 * One job at a time.
 *
 * The pipeline is deliberately serialised: encoding is the slow, CPU-hungry
 * part, and running two encodes at once on a dual-core 2017 MacBook Air makes
 * both slower and the machine unusable. So this is a single slot with a
 * cancellation handle and a rolling log, not a queue.
 *
 * Progress is pushed to the renderer rather than polled, so the window cannot
 * drift out of step with the work.
 */

const { EventEmitter } = require('events');

const MAX_LOG_LINES = 400;

class JobRunner extends EventEmitter {
  constructor() {
    super();
    this.current = null;
    this.logLines = [];
    this.controller = null;
    this.startedAt = null;
  }

  get busy() {
    return Boolean(this.current);
  }

  get status() {
    if (!this.current) return { busy: false, log: this.logLines.slice(-80) };
    return {
      busy: true,
      kind: this.current.kind,
      stage: this.current.stage,
      fraction: this.current.fraction,
      message: this.current.message,
      startedAt: this.startedAt,
      cancellable: Boolean(this.controller),
      log: this.logLines.slice(-80),
    };
  }

  log(line) {
    const text = String(line || '').trimEnd();
    if (!text) return;
    // A single dvdauthor line can be enormous; wrap it rather than dumping a
    // wall of text into the window.
    for (const piece of text.match(/.{1,160}/g) || []) {
      this.logLines.push(piece);
    }
    if (this.logLines.length > MAX_LOG_LINES) {
      this.logLines.splice(0, this.logLines.length - MAX_LOG_LINES);
    }
    this.emit('log', text);
  }

  clearLog() {
    this.logLines = [];
    this.emit('log-cleared');
  }

  /**
   * Run one job. `fn` receives a context with `signal`, `onProgress` and
   * `log`. Returns whatever `fn` returns.
   */
  async run(kind, fn) {
    if (this.busy) {
      throw new Error('Something is already running. Wait for it to finish, or stop it first.');
    }

    this.controller = new AbortController();
    this.startedAt = Date.now();
    this.current = { kind, stage: 'starting', fraction: 0, message: 'Starting\u2026' };
    this.emit('state', this.status);

    /*
      Progress is sent on when it says something new: a different stage or
      message, another whole percent, or a second since the last one.

      Every update re-renders the window, and the encoder and the burn both
      report several times a second. On a dual-core laptop the window redrawing
      a progress bar that has not visibly moved is processor time taken from the
      encoder it is reporting on.
    */
    let lastSent = { stage: null, message: null, percent: -1, at: 0 };
    const context = {
      signal: this.controller.signal,
      log: (line) => this.log(line),
      onProgress: (update) => {
        if (!this.current) return;
        this.current = {
          ...this.current,
          stage: update.stage || this.current.stage,
          fraction: typeof update.fraction === 'number' ? update.fraction : this.current.fraction,
          message: update.message || this.current.message,
        };
        const percent = Math.floor((this.current.fraction || 0) * 100);
        const now = Date.now();
        if (
          this.current.stage === lastSent.stage &&
          this.current.message === lastSent.message &&
          percent === lastSent.percent &&
          now - lastSent.at < 1000
        ) {
          return;
        }
        lastSent = { stage: this.current.stage, message: this.current.message, percent, at: now };
        this.emit('state', this.status);
      },
    };

    try {
      const result = await fn(context);
      this.emit('state', { busy: false, log: this.logLines.slice(-80), finished: 'ok' });
      return result;
    } catch (err) {
      const aborted = Boolean(err && (err.isAbort || err.name === 'AbortError'));
      // Kept in the activity log, so the reason is still there to read after the
      // message on the page has been dismissed.
      if (!aborted) this.log(`Failed: ${String((err && err.message) || err)}`);
      this.emit('state', {
        busy: false,
        log: this.logLines.slice(-80),
        finished: aborted ? 'cancelled' : 'failed',
      });
      throw err;
    } finally {
      this.current = null;
      this.controller = null;
      this.startedAt = null;
    }
  }

  cancel() {
    if (!this.controller) return false;
    this.controller.abort();
    this.log('Stopping\u2026');
    return true;
  }
}

module.exports = { JobRunner };
