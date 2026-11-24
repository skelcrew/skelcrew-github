// Loaded before the plugin in tests that need its output to count as a terminal's, as it is when
// you run setup yourself, though the test reads it through a pipe.
Object.defineProperty(process.stdout, "isTTY", { value: true });
