"use client";

/**
 * The app's Markdown renderer (Streamdown): GFM, line breaks, KaTeX math and
 * code highlighting, with remote images blocked. Everything renders from
 * local assets (KaTeX CSS and fonts ship with the app).
 */
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import type { ComponentProps } from "react";
import { memo } from "react";
import remarkBreaks from "remark-breaks";
import {
  defaultRehypePlugins,
  Streamdown,
  type PluginConfig,
  type StreamdownProps,
} from "streamdown";
import { cn } from "@/lib/utils";
import { mdComponents } from "@/components/md-blocks";
import { repairMathForDisplay, transformMathDelimiters } from "@/src/core";

export type MarkdownResponseProps = ComponentProps<typeof Streamdown>;

// Type-only version skew: @streamdown/code bundles shiki@3 types while
// streamdown@2.5 expects shiki@4 types. Both work at runtime (each ships its
// own highlighter); the cast papers over the .d.ts mismatch.
//
// Standard dollar authoring (owner, 2026-10-12): $...$ inline, $$ fenced
// on separate lines for display. transformMathDelimiters stays as the
// compatibility reader for old \(...\)/\[...\] content; its two-dollar
// output remains valid alongside native single-dollar math.
//
// remark-breaks rides in the cjk plugin's remarkPluginsAfter slot (public
// PluginConfig API): Streamdown's bare `remarkPlugins` PROP would REPLACE the
// defaults ([remark-gfm, codeMeta]), silently dropping GFM and code-fence
// metastring parsing. The slot appends after the defaults, which is the
// standard remark-gfm → remark-breaks order.
//
// MERMAID is app-owned since the chrome-melt wave (2026-09-19): the md-blocks
// `code` override intercepts mermaid fences and renders via
// components/mermaid-render.ts — streamdown's internal mermaid machinery
// (the plugin entry + the `mermaid` prop) is retired with it.
export const streamdownPlugins = {
  cjk: {
    ...cjk,
    remarkPluginsAfter: [...cjk.remarkPluginsAfter, remarkBreaks],
  },
  code,
  math: createMathPlugin({ singleDollarTextMath: true }),
} as unknown as PluginConfig;

// Remend's incomplete-HTML heuristic mistakes `<b` in `$a<b$` for a
// partial tag and deletes the remaining source before math can tokenize.
// Preserve that text (unfinished prose HTML may show literally); Streamdown's
// separate sanitization/hardening and all other Markdown repairs stay enabled.
export const streamdownRemend = { htmlTags: false };

// Model output must not load remote images: a rendered
// ![x](https://host/?d=...) sends data out with no click. Streamdown's
// default harden step allows every image prefix, so this keeps its
// raw → sanitize → harden pipeline and changes one option. A blocked image
// becomes an "[Image blocked: alt]" badge. data: images were already
// blocked by the sanitize step; the app's image and SVG cards don't render
// through markdown. Links are unchanged.
const [hardenPlugin, hardenOptions] = defaultRehypePlugins.harden as [unknown, Record<string, unknown>];
export const streamdownRehypePlugins = Object.values({
  ...defaultRehypePlugins,
  harden: [hardenPlugin, { ...hardenOptions, allowedImagePrefixes: [] }],
}) as NonNullable<StreamdownProps["rehypePlugins"]>;

export const MarkdownResponse = memo(
  ({ className, children, ...props }: MarkdownResponseProps) => {
    // Legacy backslash delimiters are converted in a single linear scan;
    // native dollar math passes through to Streamdown unchanged. Incomplete
    // legacy spans are left for a later render when their closer arrives.
    const content =
      typeof children === "string"
        ? transformMathDelimiters(children)
        : children;

    return (
      <Streamdown
        className={cn(
          // Source Sans 3 + emphasis-color tokens on every markdown surface
          // (labels stay JetBrains Mono). Unlayered plain CSS wins over text-sm.
          "lh-prose size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          className
        )}
        components={mdComponents}
        plugins={streamdownPlugins}
        rehypePlugins={streamdownRehypePlugins}
        remend={streamdownRemend}
        {...props}
      >
        {content}
      </Streamdown>
    );
  },
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating
);

MarkdownResponse.displayName = "MarkdownResponse";

/** Recovery is a tool-text presentation concern, not a shape/answer-data
 * transform: it repairs over-escaped math before rendering. */
export function RepairedMarkdownResponse({ children, ...props }: MarkdownResponseProps) {
  return (
    <MarkdownResponse {...props}>
      {typeof children === "string" ? repairMathForDisplay(children) : children}
    </MarkdownResponse>
  );
}

