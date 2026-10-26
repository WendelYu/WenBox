const fs = require('node:fs');
const path = require('node:path');
function currentNotes(source, version) {
    const sections = source.split(/(?=^## WenBox v)/m);
    const section = sections.find(value => value.startsWith(`## WenBox v${version} ·`));
    if (!section) throw new Error(`Missing release notes for v${version}`);
    return section.replace(/\n---\s*$/, '').trim() + '\n';
}
function releaseNotes(source, version) {
    const notes = currentNotes(source, version);
    if (notes.includes('### macOS 安装提醒')) return notes;
    return notes + `
### macOS 安装提醒

打开 WenBox-macOS-v${version}-universal.dmg，将 WenBox.app 拖到「应用程序」，再从「应用程序」启动。通用包支持 Apple Silicon 和 Intel Mac。

当前应用尚未经过 Apple 公证。如从本仓库下载后提示「已损坏」或无法打开，在终端执行：

\`\`\`bash
xattr -dr com.apple.quarantine /Applications/WenBox.app
\`\`\`

然后重新打开 WenBox。仅提示无法验证开发者时，也可在「系统设置 → 隐私与安全性」选择「仍要打开」。仅对确认来自本仓库的安装包操作，无需关闭全局安全检查。
`;
}
if (require.main === module) {
    const root = path.resolve(__dirname, '..');
    const { version } = require(path.join(root, 'package.json'));
    fs.writeFileSync(path.join(root, 'release_notes.md'), releaseNotes(fs.readFileSync(path.join(root, 'docs/RELEASE_NOTES.md'), 'utf8'), version));
}
module.exports = { currentNotes, releaseNotes };
