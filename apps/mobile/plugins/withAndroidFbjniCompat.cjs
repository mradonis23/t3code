const { withAppBuildGradle } = require("expo/config-plugins");

const FBJNI_COMPAT_BLOCK = `// T3 Android compatibility: fbjni 0.8.1 requires __cxa_init_primary_exception,
// which is unavailable from the libc++_shared shipped by the production binary
// on the supported Fold runtime. 0.7.0 is the production-proven compatible ABI.
configurations.all {
    resolutionStrategy.force 'com.facebook.fbjni:fbjni:0.7.0'
}

`;

module.exports = function withAndroidFbjniCompat(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "groovy") {
      throw new Error("withAndroidFbjniCompat requires a Groovy app/build.gradle");
    }

    if (!nextConfig.modResults.contents.includes("com.facebook.fbjni:fbjni:0.7.0")) {
      nextConfig.modResults.contents = nextConfig.modResults.contents.replace(
        /\ndependencies\s*\{/,
        `\n${FBJNI_COMPAT_BLOCK}dependencies {`,
      );
    }

    return nextConfig;
  });
};
