import Markdown from "react-markdown";

// Keep generated answers to document formatting. Raw HTML remains escaped text;
// do not add rehype-raw or dangerouslySetInnerHTML to this rendering path.
const allowedElements = [
  "p", "strong", "em", "ul", "ol", "li", "blockquote", "pre", "code",
  "hr", "br", "a", "img", "h1", "h2", "h3", "h4", "h5", "h6",
];

export function AnswerMarkdown({ text }: { text: string }) {
  return (
    <div className="answer-text">
      <Markdown
        allowedElements={allowedElements}
        urlTransform={(url, key) => {
          // Only explicit web links are navigable. Relative links could navigate
          // inside our app; image URLs must never cause external requests.
          if (key !== "href" || !/^https?:\/\//i.test(url)) return undefined;
          try {
            const parsed = new URL(url);
            if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.href;
          } catch { /* Malformed destinations are displayed as ordinary text. */ }
          return undefined;
        }}
        components={{
          a: ({ href, children }) => href
            ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
            : <span>{children}</span>,
          // Preserve useful image descriptions without fetching generated URLs.
          img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image omitted]"}</span>,
          // Answer headings sit below the page and answer-status headings.
          h1: ({ children }) => <h3>{children}</h3>,
          h2: ({ children }) => <h3>{children}</h3>,
          h3: ({ children }) => <h3>{children}</h3>,
          h4: ({ children }) => <h4>{children}</h4>,
          h5: ({ children }) => <h5>{children}</h5>,
          h6: ({ children }) => <h6>{children}</h6>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
