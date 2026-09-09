import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { ReadinessService } from "./readiness";

@ApiTags("health")
@Controller("ready")
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get()
  @ApiOperation({ summary: "Dependency readiness; PostgreSQL SELECT 1 and Redis PING" })
  @ApiResponse({ status: 503, description: "A required local dependency is unavailable" })
  async getReadiness() {
    if (!(await this.readiness.check())) throw new ServiceUnavailableException();
    return { status: "ok", service: "zzsh-api", scope: "readiness" } as const;
  }
}
