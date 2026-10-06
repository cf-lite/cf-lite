import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export default class Onboarding extends WorkflowEntrypoint<Env, { userId: string }> {
  async run(event: WorkflowEvent<{ userId: string }>, step: WorkflowStep) {
    const profile = await step.do("create profile", async () => ({ id: event.payload.userId, plan: "free" }));
    await step.sleep("let it settle", "1 second");
    await step.do("welcome", async () => { await this.env.STATE.put(`wf:${profile.id}`, profile.plan); });
  }
}
