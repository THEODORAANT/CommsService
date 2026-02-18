export function normalizeForwardedNoteBody(rawBody: string): string {
    const source = String(rawBody ?? "");
    const trimmed = source.trim();

    if (!trimmed) {
        return source;
    }

    let wrappedPayload: string | null = null;
    if (trimmed.startsWith(":d{")) {
        wrappedPayload = trimmed.slice(2);
    } else if (trimmed.startsWith("d{")) {
        wrappedPayload = trimmed.slice(1);
    }

    if (!wrappedPayload) {
        return source;
    }

    try {
        const parsed = JSON.parse(wrappedPayload) as Record<string, unknown>;
        const normalized =
            (typeof parsed.note_raw === "string" && parsed.note_raw) ||
            (typeof parsed.body === "string" && parsed.body) ||
            (typeof parsed.note === "string" && parsed.note);

        return normalized || source;
    } catch {
        return source;
    }
}
