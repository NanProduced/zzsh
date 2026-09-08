import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
@ApiTags("health")
@Controller("health")
export class HealthController {
  @Get()
  @ApiOperation({ summary: "Process liveness only; no database or provider readiness assertion" })
  getHealth() { return { status: "ok", service: "zzsh-api", scope: "liveness" } as const; }
}
