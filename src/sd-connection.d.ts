// Plugin SDK nie eksportuje połączenia publicznie; esbuild mapuje ten moduł na jego plik (--alias w package.json).
declare module "sd-connection" {
	export const connection: { send(command: { event: string; context: string; payload: unknown }): Promise<void> };
}
