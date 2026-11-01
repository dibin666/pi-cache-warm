/** Read Anthropic's initial usage event, then cancel without consuming generated content. */
export class UnverifiedCacheError extends Error {}

const MAX_PROBE_CHARS = 256 * 1024;

export async function readAnthropicStart(response: Response, abort: () => void): Promise<any> {
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") || !response.body)
			throw new UnverifiedCacheError("The endpoint did not return a streaming response; cache refresh is unverified");
		reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let data: string[] = [];
		let scanned = 0;
		const dispatch = (): any => {
			if (!data.length) return undefined;
			const text = data.join("\n");
			data = [];
			let event: any;
			try {
				event = JSON.parse(text);
			} catch {
				throw new UnverifiedCacheError("Invalid streaming event; cache refresh is unverified");
			}
			if (event?.type === "error") throw new Error(String(event.error?.message ?? "Provider stream error").slice(0, 300));
			if (event?.type === "message_start") return event;
			if (["content_block_start", "content_block_delta", "message_delta", "message_stop"].includes(event?.type))
				throw new UnverifiedCacheError("Generation started without initial cache usage; cache refresh is unverified");
			// A heartbeat ping (or a comment) is not evidence that any prompt cache was read.
			return undefined;
		};
		const line = (text: string): any => {
			if (!text) return dispatch();
			if (text.startsWith("data:")) data.push(text.slice(5).replace(/^ /, ""));
			return undefined;
		};
		for (;;) {
			const { done, value } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			if (buffer.length > MAX_PROBE_CHARS) throw new UnverifiedCacheError("Cache usage event exceeded the probe limit");
			for (;;) {
				const end = /\r\n|\r|\n/.exec(buffer);
				if (!end || (!done && end[0] === "\r" && end.index === buffer.length - 1)) break;
				const text = buffer.slice(0, end.index);
				buffer = buffer.slice(end.index + end[0].length);
				scanned += text.length + end[0].length;
				if (scanned > MAX_PROBE_CHARS) throw new UnverifiedCacheError("No cache usage within the probe limit");
				const event = line(text);
				if (event) return event;
			}
			if (done) {
				const event = line(buffer) ?? dispatch();
				if (event) return event;
				throw new UnverifiedCacheError("The stream ended without initial cache usage; cache refresh is unverified");
			}
		}
	} finally {
		// Aborting the fetch as well as cancelling its reader stops a real network body promptly.
		abort();
		try {
			if (reader) await reader.cancel();
			else await response.body?.cancel();
		} catch {
			/* already aborted */
		}
		reader?.releaseLock();
	}
}
