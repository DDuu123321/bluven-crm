/** A named job that runs every `everyMs`, never overlapping with itself. */
export interface Job {
  name: string;
  everyMs: number;
  /** Returns a short summary for the log, or nothing when there was nothing to do. */
  run: () => Promise<string | void>;
}

export interface Scheduler {
  stop: () => Promise<void>;
}

/**
 * Runs each job on its own interval, first run shortly after start. A job that is still running
 * when its next turn comes is skipped for that turn. Failures are logged and never stop the loop.
 */
export function startScheduler(jobs: Job[], log: (line: string) => void = console.log): Scheduler {
  const running = new Set<string>();
  const pending = new Set<Promise<void>>();
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;

  const tick = (job: Job) => {
    if (stopped || running.has(job.name)) return;
    running.add(job.name);
    const p = job
      .run()
      .then((summary) => {
        if (summary) log(`[${new Date().toISOString()}] ${job.name}: ${summary}`);
      })
      .catch((e: unknown) => {
        console.error(`[${new Date().toISOString()}] ${job.name} failed`, e);
      })
      .finally(() => {
        running.delete(job.name);
        pending.delete(p);
      });
    pending.add(p);
  };

  jobs.forEach((job, i) => {
    // The first runs are spread out, and each job's interval counts from its own first run. Were
    // the intervals all started now, jobs with the same period would hit the database together
    // on every turn after the first.
    timers.push(
      setTimeout(() => {
        tick(job);
        timers.push(setInterval(() => tick(job), job.everyMs));
      }, 1_000 + i * 500),
    );
  });

  return {
    async stop() {
      stopped = true;
      timers.forEach((t) => clearTimeout(t));
      await Promise.allSettled([...pending]);
    },
  };
}
