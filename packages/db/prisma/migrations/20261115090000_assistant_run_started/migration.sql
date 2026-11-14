-- A request to the model is recorded when it is sent, not when it is answered: the hourly limit
-- per person counts the rows, and requests sent at the same moment were each counted before
-- any of them had written its row.
ALTER TYPE "AiRunStatus" ADD VALUE 'STARTED';
