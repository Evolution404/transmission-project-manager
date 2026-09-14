export interface ScheduledTaskInvocation {
  task: string;
  scheduledAt: Date;
}

export interface SchedulerPort {
  dispatch(invocation: ScheduledTaskInvocation): Promise<void>;
}
