"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { pluginViewPath } from "@/components/plugin-manager";

const LINKS = [
	{ href: "/", label: "Practice" },
	{ href: pluginViewPath("flashcards", "library"), label: "Flashcards" },
];

/** The whole app navigation: the M3Kang practice and the flashcards library. */
export function AppNav() {
	const pathname = usePathname();
	return (
		<header className="border-b border-border">
			<nav aria-label="Main" className="mx-auto flex max-w-5xl items-center gap-1 px-4 py-2 text-sm md:px-6">
				<Link href="/" className="mr-4 flex items-center gap-2 font-title text-xl tracking-tight">
					<span aria-hidden className="size-2.5 rounded-full bg-(--cortex-accent) shadow-[0_0_12px_var(--cortex-accent)]" />
					Cortex
				</Link>
				{LINKS.map((link) => {
					const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
					return (
						<Link
							key={link.href}
							href={link.href}
							aria-current={active ? "page" : undefined}
							className={cn(
								"rounded-md px-3 py-1.5 transition-colors hover:bg-muted",
								active ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
							)}
						>
							{link.label}
						</Link>
					);
				})}
			</nav>
		</header>
	);
}
