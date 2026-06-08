// fallow-ignore-file unused-file
globalThis.fetch = Object.assign(
  async (input: string | URL | Request) => {
    throw new Error(`Unexpected network call: ${String(input)}`);
  },
  { preconnect: globalThis.fetch.preconnect },
);
