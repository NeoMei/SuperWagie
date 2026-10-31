export function refuseLiveAnalysis(): void {
  throw new Error("SuperWagie bundles offline reconstruction only. Use build, build-v1 or raster-patch with an existing analysis package. Live analyze/run require dedicated configured-model adapters and are unavailable.");
}
