import { z } from "zod";
import { mutate } from "../core/step.ts";
import type { Task, TaskContext, TaskResult } from "../core/task.ts";

const ParamsSchema = z.object({
  message: z.string().min(1).describe("Message to echo"),
  repeat: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(1)
    .describe("Number of times to repeat"),
});

type Params = z.infer<typeof ParamsSchema>;

/**
 * Reference task. Carries no connectors, but exercises TaskExecutor,
 * TaskRegistry, and generated web form fields end to end.
 */
export const exampleTask: Task<Params> = {
  id: "example-task",
  name: "Example task",
  description: "Ad-hoc task that echoes a message N times.",
  kind: "task",
  paramsSchema: ParamsSchema,

  async run(ctx: TaskContext, params: Params): Promise<TaskResult> {
    let processed = 0;

    for (let i = 0; i < params.repeat; i++) {
      await ctx.step(`echo:${i + 1}`, async () => {
        await mutate(ctx, `echo "${params.message}"`, async () => {
          ctx.logger.info({ i: i + 1 }, params.message);
        });
      });
      processed++;
    }

    return {
      itemsProcessed: processed,
      details: { message: params.message, repeat: params.repeat },
    };
  },
};
