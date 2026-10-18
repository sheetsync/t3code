import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ProjectScriptPortsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  scriptIds: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(100)),
});
export type ProjectScriptPortsInput = typeof ProjectScriptPortsInput.Type;

export const ProjectScriptPortsResult = Schema.Struct({
  ports: Schema.Record(
    Schema.String,
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  ),
});

export class ProjectScriptPortUnavailableError extends Schema.TaggedError<ProjectScriptPortUnavailableError>()(
  "ProjectScriptPortUnavailableError",
  { startPort: Schema.Int, attempts: Schema.Int },
) {
  override get message(): string {
    return `Could not assign a preview port after checking ${this.attempts} ports. Stop an unused server and try again.`;
  }
}
