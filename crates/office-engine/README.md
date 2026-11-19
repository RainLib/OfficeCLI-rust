# Office Engine

可由 Rust 程序直接调用的文档创建、原生打开、HTML 转换及 HCD 独立 HTML 导出能力。
库不依赖 `officecli`，不解析命令行参数，也不启动 OfficeCLI 子进程。

```rust,no_run
use office_engine::{convert_html, create_document, open_document, CreateOptions};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let created = create_document(
        "example.docx",
        None,
        &CreateOptions {
            locale: Some("zh-CN".into()),
            ..Default::default()
        },
    )?;
    let handler = open_document(&created.path, false)?;
    assert!(handler.validate()?.is_empty());

    let summary = convert_html(
        "source.html".as_ref(),
        "converted.docx".as_ref(),
        "docx",
    )?;
    println!("{} blocks; {}", summary.block_count, summary.fidelity);
    Ok(())
}
```

创建时默认拒绝覆盖；`CreateOptions::overwrite` 显式控制替换。库只使用传入的语言设置，
CLI 对 `LANG`、`LC_ALL` 和 `--locale` 的解析保留在命令适配层。
`try_open_document` 对未注册的原生格式返回 `None`，供宿主继续查找外部插件。

## 注册和职责

- `office-engine/src/registry.rs`：原生处理器、创建器、HTML 输出器在同一条注册项中声明。
  `can_open`、`can_create`、`can_convert_html` 从实际注册的函数推导。
- `hcd-formats/src/registry.rs`：每个 HCD 格式的导入、原格式导出、导出预检统一登记。
  外层 `import_document`、`export_document`、`validate_source_export` 共用该表。
- `office_engine::registry::capabilities()`：合并两组实现的能力，区分原生打开、创建、
  HTML 重建、HCD 导入、依赖原始文件的导出、图片重编码和 HCD 打包。
  CLI/HTTP 的能力契约、HTTP 导出目标及 MCP 的导出参数从这些注册信息生成。

新增格式时，在相应领域实现适配器并登记；只有需要新的编辑语义时，才扩展 HCD 补丁协议。
静态注册信息描述实现能力；特定文档是否可导出，仍由原始文件、修订、字体和渲染器的
运行时预检决定。

HCD 补丁的事务、版本和索引编排保留在 `hcd-core/src/patch.rs`。PDF 和 PPTX 的专用
实现分别位于 `patch/pdf.rs`、`patch/pptx.rs`；XLSX 在 `patch/xlsx/` 下按单元格、
网格和工作表划分职责，外部继续使用同一个 `apply_patch` 入口。
这些编辑模块仍属于 `hcd-core`；后续迁移为独立 crate 需要先收窄内部存储和补丁类型接口。

CLI 继续负责参数、环境默认值、驻留会话和插件发现。HTTP 服务继续负责身份、协作、
业务存储和导出进程管理；完整 HCD 导出编排尚有部分保留在 CLI，当前提取的库边界覆盖
创建、原生打开、HTML 转换及独立 HTML 导出。

## 验证

```sh
cargo test -p office-engine -p hcd-core -p hcd-formats --lib
cargo test -p officecli --tests
engine_demo_dir="$(mktemp -d)"
cargo run -p office-engine --example library_usage -- "$engine_demo_dir"
```

独立示例会创建 DOCX，并把 HTML 转为 DOCX、XLSX、PPTX、PDF，随后用原生处理器校验结果。
库内测试另覆盖内容读回、覆盖保护、语言设置和最小 DOCX 模板；迁移的转换测试继续覆盖
富文本、表格、图片、分页和字体行为。
