import type { KeyScope } from "@/core/scopes";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Caller } from "./caller";

const context = new AsyncLocalStorage<Caller>();
export const currentCaller = () => context.getStore();
export const withCaller = <T>(caller: Caller, work: () => T): T => context.run(caller, work);

/** What the caller's API key allows; sessions and every other kind of caller are not narrowed. */
export const callerScope = (c: Caller | null | undefined): KeyScope =>
  c?.kind === "user" && c.token ? c.token.scope : "full";
