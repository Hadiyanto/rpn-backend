import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Integration tests share one local database and TRUNCATE it; run files one at a time.
        fileParallelism: false,
    },
});
