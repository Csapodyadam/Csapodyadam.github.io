"""
Portfolio Project Agent
=======================
Reads a project folder, builds a project page, and adds it to the portfolio.

Usage:
    python add_project.py "C:\\path\\to\\project\\folder"
    python add_project.py "C:\\path\\to\\project\\folder" --slug my-project-name

Requirements:
    pip install anthropic pymupdf
    Set environment variable: ANTHROPIC_API_KEY=your-key-here
"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

import anthropic

# ── Paths ──────────────────────────────────────────────────────────────────────
PORTFOLIO_ROOT = Path(__file__).parent
ASSETS_DIR     = PORTFOLIO_ROOT / "assets" / "images"
PROJECTS_DIR   = PORTFOLIO_ROOT / "projects"
PROJECTS_JS    = PORTFOLIO_ROOT / "src" / "projects.js"
TEMPLATE_PAGE  = PORTFOLIO_ROOT / "projects" / "opamp-tester.html"

client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from environment


# ── Tool implementations ───────────────────────────────────────────────────────

def list_files(folder_path: str) -> str:
    path = Path(folder_path)
    if not path.exists():
        return f"Error: path does not exist: {folder_path}"
    results = []
    for item in sorted(path.rglob("*")):
        # Skip hidden folders and git internals
        if any(part.startswith(".") for part in item.parts):
            continue
        if item.is_file():
            size_kb = item.stat().st_size // 1024
            results.append(f"{item.relative_to(path)}  ({size_kb}KB, {item.suffix or 'no ext'})")
    return "\n".join(results) if results else "No files found."


def read_text_file(file_path: str) -> str:
    path = Path(file_path)
    if not path.exists():
        return f"Error: file not found: {file_path}"
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return f"Error reading file: {e}"


def read_pdf(file_path: str) -> str:
    try:
        import fitz  # pymupdf
        doc = fitz.open(file_path)
        pages = [page.get_text() for page in doc]
        return "\n\n--- Page break ---\n\n".join(pages)
    except ImportError:
        return "Error: pymupdf not installed. Run: pip install pymupdf"
    except Exception as e:
        return f"Error reading PDF: {e}"


def extract_pdf_images(pdf_path: str, project_slug: str) -> str:
    try:
        import fitz
        out_dir = ASSETS_DIR / project_slug
        out_dir.mkdir(parents=True, exist_ok=True)
        doc = fitz.open(pdf_path)
        saved = []
        for page_num, page in enumerate(doc):
            for img_idx, img in enumerate(page.get_images(full=True)):
                xref  = img[0]
                base  = doc.extract_image(xref)
                fname = out_dir / f"page{page_num + 1}_img{img_idx + 1}.{base['ext']}"
                fname.write_bytes(base["image"])
                saved.append(f"assets/images/{project_slug}/{fname.name}")
        return f"Extracted {len(saved)} images:\n" + "\n".join(saved)
    except Exception as e:
        return f"Error extracting PDF images: {e}"


def copy_image(source_path: str, project_slug: str) -> str:
    try:
        src = Path(source_path)
        if not src.exists():
            return f"Error: file not found: {source_path}"
        out_dir = ASSETS_DIR / project_slug
        out_dir.mkdir(parents=True, exist_ok=True)
        dest = out_dir / src.name
        shutil.copy2(src, dest)
        return f"Copied to: assets/images/{project_slug}/{src.name}"
    except Exception as e:
        return f"Error copying image: {e}"


def get_portfolio_context() -> str:
    """Returns the current projects.js and template HTML so Claude can match the style."""
    parts = []
    if PROJECTS_JS.exists():
        parts.append(f"=== src/projects.js ===\n{PROJECTS_JS.read_text(encoding='utf-8')}")
    if TEMPLATE_PAGE.exists():
        parts.append(f"=== projects/opamp-tester.html (template) ===\n{TEMPLATE_PAGE.read_text(encoding='utf-8')}")
    return "\n\n".join(parts) if parts else "No context found."


def write_project_page(slug: str, html_content: str) -> str:
    try:
        out_path = PROJECTS_DIR / f"{slug}.html"
        out_path.write_text(html_content, encoding="utf-8")
        return f"Written: projects/{slug}.html"
    except Exception as e:
        return f"Error writing project page: {e}"


def update_projects_js(new_entry: str) -> str:
    """Appends a new object to the PROJECTS array in projects.js."""
    try:
        content = PROJECTS_JS.read_text(encoding="utf-8")

        # Find the PROJECTS array boundaries
        start_idx = content.find("const PROJECTS = [")
        if start_idx == -1:
            return "Error: could not locate PROJECTS array"

        close_idx = content.find("];", start_idx)
        if close_idx == -1:
            return "Error: could not find end of PROJECTS array"

        # Find the last closing brace of the last entry
        last_brace = content.rfind("}", start_idx, close_idx)
        if last_brace == -1:
            return "Error: PROJECTS array appears empty or malformed"

        # Insert: add comma after last entry, then new entry, then close
        new_content = (
            content[: last_brace + 1]
            + ",\n  "
            + new_entry.strip()
            + "\n"
            + content[close_idx:]
        )
        PROJECTS_JS.write_text(new_content, encoding="utf-8")
        return "projects.js updated successfully."
    except Exception as e:
        return f"Error updating projects.js: {e}"


def git_commit_push(message: str) -> str:
    try:
        os.chdir(PORTFOLIO_ROOT)
        subprocess.run(["git", "add", "."], check=True, capture_output=True)
        result = subprocess.run(
            ["git", "commit", "-m", message], capture_output=True, text=True
        )
        if result.returncode != 0:
            return f"Commit failed: {result.stderr.strip()}"
        push = subprocess.run(["git", "push"], capture_output=True, text=True)
        if push.returncode != 0:
            return f"Committed locally, but push failed: {push.stderr.strip()}"
        return "Committed and pushed to GitHub successfully."
    except Exception as e:
        return f"Error during git operations: {e}"


# ── Tool definitions (JSON schema) ─────────────────────────────────────────────
TOOLS = [
    {
        "name": "list_files",
        "description": "List all files in a directory recursively. Use this first to understand what's in the project folder.",
        "input_schema": {
            "type": "object",
            "properties": {
                "folder_path": {"type": "string", "description": "Absolute path to the folder to scan."}
            },
            "required": ["folder_path"],
        },
    },
    {
        "name": "read_text_file",
        "description": "Read any plain text file: .txt, .md, .html, .js, .css, README, etc.",
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Absolute path to the file."}
            },
            "required": ["file_path"],
        },
    },
    {
        "name": "read_pdf",
        "description": "Extract all text from a PDF file. Use for documentation PDFs.",
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Absolute path to the PDF."}
            },
            "required": ["file_path"],
        },
    },
    {
        "name": "extract_pdf_images",
        "description": "Extract all embedded images from a PDF and save them to the portfolio assets folder. Returns a list of saved image paths.",
        "input_schema": {
            "type": "object",
            "properties": {
                "pdf_path":      {"type": "string", "description": "Absolute path to the PDF."},
                "project_slug":  {"type": "string", "description": "URL-friendly slug, e.g. 'cv-display-pcb'."},
            },
            "required": ["pdf_path", "project_slug"],
        },
    },
    {
        "name": "copy_image",
        "description": "Copy a standalone image file (PNG, JPG, etc.) into the portfolio assets folder for this project.",
        "input_schema": {
            "type": "object",
            "properties": {
                "source_path":   {"type": "string", "description": "Absolute path to the image file."},
                "project_slug":  {"type": "string", "description": "URL-friendly project slug."},
            },
            "required": ["source_path", "project_slug"],
        },
    },
    {
        "name": "get_portfolio_context",
        "description": "Read the current projects.js and the template project page (opamp-tester.html). Always call this before writing any files so you can match the existing style exactly.",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "write_project_page",
        "description": "Write the complete HTML for a new project page into the projects/ folder. The file will be projects/<slug>.html.",
        "input_schema": {
            "type": "object",
            "properties": {
                "slug":         {"type": "string", "description": "URL-friendly slug, e.g. 'cv-display-pcb'."},
                "html_content": {"type": "string", "description": "Full HTML content of the project page."},
            },
            "required": ["slug", "html_content"],
        },
    },
    {
        "name": "update_projects_js",
        "description": "Append a new project entry object to the PROJECTS array in src/projects.js.",
        "input_schema": {
            "type": "object",
            "properties": {
                "new_entry": {
                    "type": "string",
                    "description": (
                        "A JavaScript object literal for the new project, matching the existing format. "
                        "Example: {title: \"My Project\", description: \"...\", tags: [\"KiCad\"], "
                        "image: \"\", links: [], page: \"projects/my-project.html\", featured: false}"
                    ),
                }
            },
            "required": ["new_entry"],
        },
    },
    {
        "name": "git_commit_push",
        "description": "Stage all changed files, create a git commit, and push to GitHub Pages.",
        "input_schema": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "description": "Commit message, e.g. 'Add CV Display PCB project page'."}
            },
            "required": ["message"],
        },
    },
]

TOOL_FN_MAP = {
    "list_files":           list_files,
    "read_text_file":       read_text_file,
    "read_pdf":             read_pdf,
    "extract_pdf_images":   extract_pdf_images,
    "copy_image":           copy_image,
    "get_portfolio_context": get_portfolio_context,
    "write_project_page":   write_project_page,
    "update_projects_js":   update_projects_js,
    "git_commit_push":      git_commit_push,
}


# ── System prompt ──────────────────────────────────────────────────────────────
SYSTEM_PROMPT = f"""You are a portfolio assistant for Adam Csapody's personal engineering portfolio website.

The portfolio lives at: {PORTFOLIO_ROOT}

Structure:
- index.html              — main page
- src/projects.js         — PROJECTS array (card data), SKILLS array, ROLES array
- src/styles.css          — shared dark EE-themed styles
- src/project.css         — styles for individual project pages
- src/main.js             — portfolio JS logic
- projects/<slug>.html    — individual project pages
- assets/images/<slug>/   — images for each project

Your job when given a project folder:
1. Call list_files to see what's there.
2. Read all relevant documentation (PDFs via read_pdf, text files via read_text_file).
3. Extract images (extract_pdf_images for PDFs, copy_image for standalone images).
4. Call get_portfolio_context to read the current projects.js and the opamp-tester.html template.
5. Write a complete, polished project page HTML using write_project_page — it must:
   - Use the EXACT same HTML structure and CSS classes as opamp-tester.html
   - Reference stylesheets as ../src/styles.css and ../src/project.css
   - Reference images as ../assets/images/<slug>/filename.ext
   - Be written in clear, professional English (translate if source is in another language)
   - Include all technical details found in the documentation
6. Add the project to projects.js using update_projects_js with a properly formatted JS object.
7. Commit and push with git_commit_push.

Rules:
- Never invent technical details not found in the documentation.
- If content is in Hungarian or another language, translate it accurately.
- Keep the same dark EE-themed visual style — do not alter CSS classes or layout structure.
- The projects.js entry must use the same field names as existing entries.
"""


# ── Agent loop ─────────────────────────────────────────────────────────────────
def run_agent(project_folder: str, slug_hint: str | None = None) -> None:
    print(f"\nPortfolio Agent")
    print(f"Project folder : {project_folder}")
    print(f"Portfolio root : {PORTFOLIO_ROOT}")
    print("-" * 50)

    slug_line = f"Suggested slug: {slug_hint}" if slug_hint else "Please choose a URL-friendly slug from the project name."
    prompt = (
        f"Add the project from this folder to the portfolio:\n\n"
        f"Folder: {project_folder}\n"
        f"{slug_line}\n\n"
        f"Start by listing the files, then read the documentation, extract images, "
        f"get the portfolio context, write the project page, update projects.js, and finally commit and push."
    )

    messages = [{"role": "user", "content": prompt}]

    while True:
        print("\n[Calling Claude...]\n")

        with client.messages.stream(
            model="claude-opus-4-6",
            max_tokens=8192,
            thinking={"type": "adaptive"},
            system=SYSTEM_PROMPT,
            tools=TOOLS,
            messages=messages,
        ) as stream:
            for text in stream.text_stream:
                print(text, end="", flush=True)
            response = stream.get_final_message()

        # Append assistant turn to history
        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "end_turn":
            print("\n\n[Done]")
            break

        if response.stop_reason != "tool_use":
            print(f"\n[Unexpected stop reason: {response.stop_reason}]")
            break

        # Execute tool calls
        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue

            fn = TOOL_FN_MAP.get(block.name)
            print(f"\n  > {block.name}({', '.join(f'{k}={repr(v)[:60]}' for k, v in block.input.items())})")

            result = fn(**block.input) if fn else f"Unknown tool: {block.name}"
            preview = str(result)
            print(f"    {preview[:160]}{'...' if len(preview) > 160 else ''}")

            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": str(result),
            })

        messages.append({"role": "user", "content": tool_results})


# ── Entry point ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Error: ANTHROPIC_API_KEY environment variable is not set.")
        print("Get a key at https://console.anthropic.com and run:")
        print('  $env:ANTHROPIC_API_KEY = "sk-ant-..."   (PowerShell)')
        sys.exit(1)

    parser = argparse.ArgumentParser(
        description="Add a project folder to the portfolio website."
    )
    parser.add_argument("folder", help="Path to the project folder")
    parser.add_argument(
        "--slug",
        default=None,
        help="Optional URL-friendly slug, e.g. cv-display-pcb (auto-generated if omitted)",
    )
    args = parser.parse_args()

    if not Path(args.folder).exists():
        print(f"Error: folder not found: {args.folder}")
        sys.exit(1)

    run_agent(args.folder, args.slug)
