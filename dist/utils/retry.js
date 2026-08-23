export async function withRetry(fn, { attempts = 3, baseDelayMs = 500, onRetry } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
            onRetry?.(error, attempt);
            if (attempt < attempts) {
                const delay = baseDelayMs * 2 ** (attempt - 1);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}
//# sourceMappingURL=retry.js.map