import type { Argument, Command, Option } from "commander";
import { CliError, EXIT } from "./errors";

/** Bump when the shape of `postbox describe` output changes incompatibly. */
export const DESCRIBE_FORMAT = 1;

export interface ArgumentInfo {
  name: string;
  description: string;
  required: boolean;
  variadic: boolean;
  default?: unknown;
  choices?: string[];
}
export interface OptionInfo {
  flags: string;
  name: string;
  long?: string;
  short?: string;
  description: string;
  /** The option must be given. */
  mandatory: boolean;
  /** The option takes a value: `required` (`<value>`), `optional` (`[value]`) or `none`. */
  value: "required" | "optional" | "none";
  variadic: boolean;
  negate: boolean;
  default?: unknown;
  choices?: string[];
}
export interface CommandInfo {
  name: string;
  /** Full command path from `postbox`, e.g. `collection pull`. */
  path: string;
  description: string;
  aliases: string[];
  arguments: ArgumentInfo[];
  options: OptionInfo[];
  commands: CommandInfo[];
}

/** Keeps defaults that survive JSON; functions and other values are left out. */
function plain(value: unknown): unknown {
  if (value === undefined || typeof value === "function") return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
  }
}

function withDefault<T extends object>(info: T, value: unknown, choices?: readonly string[]) {
  const result: T & { default?: unknown; choices?: string[] } = { ...info };
  const fallback = plain(value);
  if (fallback !== undefined) result.default = fallback;
  if (choices?.length) result.choices = [...choices];
  return result;
}

function argumentInfo(argument: Argument): ArgumentInfo {
  return withDefault(
    {
      name: argument.name(),
      description: argument.description,
      required: argument.required,
      variadic: argument.variadic,
    },
    argument.defaultValue,
    argument.argChoices,
  );
}

function optionInfo(option: Option): OptionInfo {
  const info: OptionInfo = {
    flags: option.flags,
    name: option.attributeName(),
    description: option.description,
    mandatory: option.mandatory,
    value: option.required ? "required" : option.optional ? "optional" : "none",
    variadic: option.variadic,
    negate: option.negate,
  };
  if (option.long) info.long = option.long;
  if (option.short) info.short = option.short;
  // Negated flags default to true implicitly; only report explicit defaults.
  return withDefault(info, option.negate ? undefined : option.defaultValue, option.argChoices);
}

const hidden = (command: Command) => (command as unknown as { _hidden?: boolean })._hidden === true;

function commandPath(command: Command): string[] {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent)
    names.unshift(current.name());
  return names;
}

export function describeCommand(command: Command): CommandInfo {
  return {
    name: command.name(),
    path: commandPath(command).join(" "),
    description: command.description(),
    aliases: command.aliases(),
    arguments: command.registeredArguments.map(argumentInfo),
    options: command.options.filter((option) => !option.hidden).map(optionInfo),
    commands: command.commands
      .filter((child) => !hidden(child) && child.name() !== "help")
      .map((child) => describeCommand(child)),
  };
}

/** Finds a subcommand by name or alias along `path`. */
export function findCommand(root: Command, path: string[]): Command | undefined {
  let current: Command | undefined = root;
  for (const part of path) {
    current = current.commands.find((child) => child.name() === part || child.aliases().includes(part));
    if (!current) return undefined;
  }
  return current;
}

export function registerDescribe(program: Command, version: string) {
  program
    .command("describe")
    .description("Print the commands, arguments, options and exit codes as JSON, for scripts and agents")
    .argument("[command...]", "Describe only this command, e.g. `collection pull`")
    .addHelpText("after", "\nExamples:\n  postbox describe\n  postbox describe collection pull")
    .exitOverride()
    .action((path: string[]) => {
      const target = findCommand(program, path);
      if (!target) throw new CliError(`Unknown command: ${path.join(" ")}`, EXIT.notFound);
      const output = {
        format: DESCRIBE_FORMAT,
        cli: program.name(),
        version,
        exitCodes: { success: 0, ...EXIT },
        command: describeCommand(target),
      };
      process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    });
}
