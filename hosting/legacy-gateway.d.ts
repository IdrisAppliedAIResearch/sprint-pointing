type GatewayEnvironment = { SPRINT_ORIGIN_URL?: string; SPRINT_GATEWAY_TOKEN?: string };
declare const gateway: { fetch(request: Request, env: GatewayEnvironment): Promise<Response> };
export default gateway;
