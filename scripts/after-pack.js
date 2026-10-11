// electron-builder afterPack hook.
//
// macOS builds are not signed with an Apple Developer ID (see "identity": null
// in package.json). Apple Silicon refuses to run code with no signature at
// all, so the packed app gets an ad-hoc signature here, before the .dmg is
// made. Users still have to allow it once in Privacy & Security.
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
};
