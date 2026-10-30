import { AsyncLocalStorage } from "node:async_hooks";
import type { Caller } from "./caller";

const context = new AsyncLocalStorage<Caller>();
export const currentCaller = () => context.getStore();
export const withCaller = <T>(caller: Caller, work: () => T): T => context.run(caller, work);
