// Original file at: cedff867

import "./markdown-text.css";
import {
	type CodeHeaderProps,
	MarkdownTextPrimitive,
	unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
	useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { memo, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button.tsx";
import { cn } from "@/lib/utils.ts";

const MarkdownTextImpl = () => {
	return <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} className="aui-md" components={defaultComponents} />;
};

export const MarkdownText = memo(MarkdownTextImpl);

function CodeHeader(props: CodeHeaderProps) {
	const { language, code } = props;
	const { isCopied, copyToClipboard } = useCopyToClipboard();
	const onCopy = () => {
		if (!code || isCopied) return;
		copyToClipboard(code);
	};

	return (
		<div className="aui-code-header-root mt-4 flex items-center justify-between gap-4 rounded-t-lg bg-muted-foreground/15 px-4 py-2 text-sm font-semibold text-foreground dark:bg-muted-foreground/20">
			<span className="aui-code-header-language lowercase [&>span]:text-xs">{language}</span>
			<TooltipIconButton tooltip="Copy" onClick={onCopy}>
				{!isCopied && <CopyIcon />}
				{isCopied && <CheckIcon />}
			</TooltipIconButton>
		</div>
	);
}

const useCopyToClipboard = ({
	copiedDuration = 3000,
}: {
	copiedDuration?: number;
} = {}) => {
	const [isCopied, setIsCopied] = useState<boolean>(false);

	const copyToClipboard = (value: string) => {
		if (!value) return;

		navigator.clipboard
			.writeText(value)
			.then(() => {
				setIsCopied(true);
				setTimeout(() => setIsCopied(false), copiedDuration);
			})
			.catch(console.error);
	};

	return { isCopied, copyToClipboard };
};

function H1Component(props: React.ComponentPropsWithoutRef<"h1">) {
	const { className, ...rest } = props;
	return (
		<h1
			className={cn("aui-md-h1 mb-8 scroll-m-20 text-4xl font-extrabold tracking-tight last:mb-0", className)}
			{...rest}
		/>
	);
}

function H2Component(props: React.ComponentProps<"h2">) {
	const { className, ...rest } = props;
	return (
		<h2
			className={cn(
				"aui-md-h2 mt-8 mb-4 scroll-m-20 text-3xl font-semibold tracking-tight first:mt-0 last:mb-0",
				className,
			)}
			{...rest}
		/>
	);
}

function H3Component(props: React.ComponentProps<"h3">) {
	const { className, ...rest } = props;
	return (
		<h3
			className={cn(
				"aui-md-h3 mt-6 mb-4 scroll-m-20 text-2xl font-semibold tracking-tight first:mt-0 last:mb-0",
				className,
			)}
			{...rest}
		/>
	);
}

function H4Component(props: React.ComponentProps<"h4">) {
	const { className, ...rest } = props;
	return (
		<h4
			className={cn(
				"aui-md-h4 mt-6 mb-4 scroll-m-20 text-xl font-semibold tracking-tight first:mt-0 last:mb-0",
				className,
			)}
			{...rest}
		/>
	);
}

function H5Component(props: React.ComponentProps<"h5">) {
	const { className, ...rest } = props;
	return <h5 className={cn("aui-md-h5 my-4 text-lg font-semibold first:mt-0 last:mb-0", className)} {...rest} />;
}

function H6Component(props: React.ComponentProps<"h6">) {
	const { className, ...rest } = props;
	return <h6 className={cn("aui-md-h6 my-4 font-semibold first:mt-0 last:mb-0", className)} {...rest} />;
}

function PComponent(props: React.ComponentProps<"p">) {
	const { className, ...rest } = props;
	return <p className={cn("aui-md-p mt-5 mb-5 leading-7 first:mt-0 last:mb-0", className)} {...rest} />;
}

function AComponent(props: React.ComponentProps<"a">) {
	const { className, ...rest } = props;
	return <a className={cn("aui-md-a font-medium text-primary underline underline-offset-4", className)} {...rest} />;
}

function BlockquoteComponent(props: React.ComponentProps<"blockquote">) {
	const { className, ...rest } = props;
	return <blockquote className={cn("aui-md-blockquote border-l-2 pl-6 italic", className)} {...rest} />;
}

function UlComponent(props: React.ComponentProps<"ul">) {
	const { className, ...rest } = props;
	return <ul className={cn("aui-md-ul my-5 ml-6 list-disc [&>li]:mt-2", className)} {...rest} />;
}

function OlComponent(props: React.ComponentProps<"ol">) {
	const { className, ...rest } = props;
	return <ol className={cn("aui-md-ol my-5 ml-6 list-decimal [&>li]:mt-2", className)} {...rest} />;
}

function HrComponent(props: React.ComponentProps<"hr">) {
	const { className, ...rest } = props;
	return <hr className={cn("aui-md-hr my-5 border-b", className)} {...rest} />;
}

function TableComponent(props: React.ComponentProps<"table">) {
	const { className, ...rest } = props;
	return (
		<table
			className={cn("aui-md-table my-5 w-full border-separate border-spacing-0 overflow-y-auto", className)}
			{...rest}
		/>
	);
}

function ThComponent(props: React.ComponentProps<"th">) {
	const { className, ...rest } = props;
	return (
		<th
			className={cn(
				"aui-md-th bg-muted px-4 py-2 text-left font-bold first:rounded-tl-lg last:rounded-tr-lg [&[align=center]]:text-center [&[align=right]]:text-right",
				className,
			)}
			{...rest}
		/>
	);
}

function TdComponent(props: React.ComponentProps<"td">) {
	const { className, ...rest } = props;
	return (
		<td
			className={cn(
				"aui-md-td border-b border-l px-4 py-2 text-left last:border-r [&[align=center]]:text-center [&[align=right]]:text-right",
				className,
			)}
			{...rest}
		/>
	);
}

function TrComponent(props: React.ComponentProps<"tr">) {
	const { className, ...rest } = props;
	return (
		<tr
			className={cn(
				"aui-md-tr m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-bl-lg [&:last-child>td:last-child]:rounded-br-lg",
				className,
			)}
			{...rest}
		/>
	);
}

function SupComponent(props: React.ComponentProps<"sup">) {
	const { className, ...rest } = props;
	return <sup className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)} {...rest} />;
}

function PreComponent(props: React.ComponentProps<"pre">) {
	const { className, ...rest } = props;
	return (
		<pre
			className={cn("aui-md-pre overflow-x-auto !rounded-t-none rounded-b-lg bg-black p-4 text-white", className)}
			{...rest}
		/>
	);
}

function CodeComponent(props: React.ComponentProps<"code">) {
	const { className, ...rest } = props;
	const isCodeBlock = useIsMarkdownCodeBlock();
	return (
		<code
			className={cn(!isCodeBlock && "aui-md-inline-code rounded border bg-muted font-semibold", className)}
			{...rest}
		/>
	);
}

const defaultComponents = memoizeMarkdownComponents({
	h1: H1Component,
	h2: H2Component,
	h3: H3Component,
	h4: H4Component,
	h5: H5Component,
	h6: H6Component,
	p: PComponent,
	a: AComponent,
	blockquote: BlockquoteComponent,
	ul: UlComponent,
	ol: OlComponent,
	hr: HrComponent,
	table: TableComponent,
	th: ThComponent,
	td: TdComponent,
	tr: TrComponent,
	sup: SupComponent,
	pre: PreComponent,
	code: CodeComponent,
	CodeHeader,
});
