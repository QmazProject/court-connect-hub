import("./.output/server/index.mjs").catch((error) => {
  console.error("CourtHub failed to start:", error);
  process.exit(1);
});
