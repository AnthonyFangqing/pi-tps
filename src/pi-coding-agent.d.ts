declare module '@mariozechner/pi-coding-agent' {
	export interface ExtensionAPI {
		on(event: string, handler: (...args: any[]) => any): ExtensionAPI;
	}

	export interface ExtensionContext {
		hasUI: boolean;
		ui: {
			theme: {
				fg(color: string, text: string): string;
			};
			setStatus(id: string, text: string): void;
		};
	}
}
