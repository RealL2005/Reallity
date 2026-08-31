export type AgentState =
  | "init"
  | "planner"
  | "executor"
  | "verify"
  | "commit"
  | "rollback"
  | "finish";

export interface FSMOptions {
  maxRounds?: number;
}
