const express = require('express');
const router  = express.Router();
const cron    = require('node-cron');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const DATA_FILE = path.join(__dirname, '../data/schedules.json');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

function loadSchedules() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}

function saveSchedules(schedules) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(schedules, null, 2));
}

// Active cron handles { scheduleId → task }
const activeTasks = new Map();

async function runPipeline(schedule) {
  const { gitlabUrl, projectId, triggerToken, branch = 'main', variables = {} } = schedule.pipelineConfig || {};
  if (!projectId || !triggerToken) throw new Error('Incomplete pipeline config (need projectId + triggerToken)');

  const gl     = gitlabUrl || process.env.GITLAB_URL || 'https://gitlab.com';
  const params = new URLSearchParams({ token: triggerToken, ref: branch });
  Object.entries(variables).forEach(([k, v]) => params.append(`variables[${k}]`, v));

  const { data } = await axios.post(
    `${gl}/api/v4/projects/${projectId}/trigger/pipeline`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return data;
}

function startSchedule(schedule) {
  if (!cron.validate(schedule.cronExpression)) return false;

  const task = cron.schedule(schedule.cronExpression, async () => {
    global.broadcast?.({ type: 'schedule_triggered', scheduleId: schedule.id, name: schedule.name });
    try {
      const data = await runPipeline(schedule);
      global.broadcast?.({ type: 'pipeline_triggered', pipelineId: data.id, status: data.status, scheduleId: schedule.id });

      const schedules = loadSchedules();
      const idx = schedules.findIndex(s => s.id === schedule.id);
      if (idx !== -1) {
        schedules[idx].lastRun        = new Date().toISOString();
        schedules[idx].lastPipelineId = data.id;
        saveSchedules(schedules);
      }
    } catch (err) {
      global.broadcast?.({ type: 'schedule_error', scheduleId: schedule.id, error: err.message });
    }
  }, { timezone: schedule.timezone || 'UTC' });

  activeTasks.set(schedule.id, task);
  return true;
}

// Restore active schedules on boot
loadSchedules().filter(s => s.enabled).forEach(s => { try { startSchedule(s); } catch {} });

// ── GET /api/scheduler/schedules ──────────────────────────────────────────────
router.get('/schedules', (req, res) => {
  res.json({ success: true, schedules: loadSchedules() });
});

// ── POST /api/scheduler/schedules ─────────────────────────────────────────────
router.post('/schedules', (req, res) => {
  const { name, cronExpression, timezone, pipelineConfig, enabled = true } = req.body;

  if (!name || !cronExpression) return res.status(400).json({ error: 'name and cronExpression are required' });
  if (!cron.validate(cronExpression)) return res.status(400).json({ error: `Invalid cron expression: "${cronExpression}"` });

  const schedule = {
    id:             `sched_${Date.now()}`,
    name,
    cronExpression,
    timezone:       timezone || 'UTC',
    pipelineConfig: pipelineConfig || {},
    enabled,
    createdAt:      new Date().toISOString(),
    lastRun:        null,
    lastPipelineId: null,
  };

  const schedules = loadSchedules();
  schedules.push(schedule);
  saveSchedules(schedules);

  if (enabled) startSchedule(schedule);

  res.json({ success: true, schedule });
});

// ── PUT /api/scheduler/schedules/:id ──────────────────────────────────────────
router.put('/schedules/:id', (req, res) => {
  const schedules = loadSchedules();
  const idx       = schedules.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Schedule not found' });

  const updated = { ...schedules[idx], ...req.body, id: schedules[idx].id, createdAt: schedules[idx].createdAt };
  schedules[idx] = updated;
  saveSchedules(schedules);

  const existing = activeTasks.get(updated.id);
  if (existing) { existing.stop(); activeTasks.delete(updated.id); }
  if (updated.enabled) startSchedule(updated);

  res.json({ success: true, schedule: updated });
});

// ── DELETE /api/scheduler/schedules/:id ───────────────────────────────────────
router.delete('/schedules/:id', (req, res) => {
  const schedules = loadSchedules();
  const idx       = schedules.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Schedule not found' });

  const existing = activeTasks.get(req.params.id);
  if (existing) { existing.stop(); activeTasks.delete(req.params.id); }

  schedules.splice(idx, 1);
  saveSchedules(schedules);
  res.json({ success: true });
});

// ── POST /api/scheduler/schedules/:id/trigger — immediate manual run ──────────
router.post('/schedules/:id/trigger', async (req, res) => {
  const schedules = loadSchedules();
  const schedule  = schedules.find(s => s.id === req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

  try {
    const data = await runPipeline(schedule);

    const idx = schedules.findIndex(s => s.id === schedule.id);
    schedules[idx].lastRun        = new Date().toISOString();
    schedules[idx].lastPipelineId = data.id;
    saveSchedules(schedules);

    global.broadcast?.({ type: 'pipeline_triggered', pipelineId: data.id, status: data.status });
    res.json({ success: true, pipeline: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
