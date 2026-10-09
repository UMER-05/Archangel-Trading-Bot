module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  setupFilesAfterEnv: [],
  // Source imports use ESM-style ".js" extensions (e.g. "./routes/trade.route.js")
  // that map to real .ts files, per this project's NodeNext module setup — but
  // ts-jest compiles tests to CommonJS (see tsconfig.jest.json) for stability
  // rather than fighting Jest's experimental ESM runner, so those extensions
  // need stripping back off for CJS-style resolution to find the .ts sources.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.jest.json",
      },
    ],
  },
  testTimeout: 20000,
};
