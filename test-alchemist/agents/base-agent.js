/**
 * BaseAgent — all sub-agents extend this.
 * Handles status lifecycle and WebSocket broadcasting.
 */
class BaseAgent {
  constructor(id, name, description, icon = '🤖') {
    this.id          = id;
    this.name        = name;
    this.description = description;
    this.icon        = icon;
    this.status      = 'idle';   // idle | running | done | error
    this.lastResult  = null;
    this.lastError   = null;
    this.startedAt   = null;
    this.finishedAt  = null;
  }

  async run(input, opts = {}) {
    this.status     = 'running';
    this.startedAt  = Date.now();
    this.lastError  = null;
    this._broadcast('running');

    try {
      const result    = await this.execute(input, opts);
      this.status     = 'done';
      this.lastResult = result;
      this.finishedAt = Date.now();
      this._broadcast('done', { durationMs: this.finishedAt - this.startedAt });
      return result;
    } catch (err) {
      this.status    = 'error';
      this.lastError = err.message;
      this.finishedAt = Date.now();
      this._broadcast('error', { error: err.message });
      throw err;
    }
  }

  // Override in subclasses
  async execute(input, opts) {
    throw new Error(`${this.id}.execute() not implemented`);
  }

  toJSON() {
    return {
      id:          this.id,
      name:        this.name,
      description: this.description,
      icon:        this.icon,
      status:      this.status,
      lastError:   this.lastError,
      startedAt:   this.startedAt,
      finishedAt:  this.finishedAt,
      durationMs:  this.finishedAt && this.startedAt ? this.finishedAt - this.startedAt : null,
    };
  }

  _broadcast(status, extra = {}) {
    if (typeof global.broadcast === 'function') {
      global.broadcast({ type: 'agent_status', agent: this.id, status, ...extra });
    }
  }
}

module.exports = BaseAgent;
