import { randomUUID } from 'node:crypto';

/**
 * Per-process identity for lock ownership. The engine pre-lock path and
 * the flush worker must present the SAME owner: the worker re-enters
 * (renews) locks the engine's pre-lock established instead of treating
 * them as contention — otherwise every write's short dict hold would
 * stall its own flush until lapse. Distinct processes get distinct ids,
 * so cross-instance coordination is unaffected. Restarting the process
 * intentionally orphans prior holds (fencing demands a new identity).
 */
export const INSTANCE_ID: string = randomUUID();
