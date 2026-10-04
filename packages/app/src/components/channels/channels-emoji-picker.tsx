import "./channels-emoji-picker.css";
import { EmojiPicker } from "frimousse";
import { memo } from "react";

type ChannelsEmojiPicker_ClassNames =
	| "ChannelsEmojiPicker"
	| "ChannelsEmojiPicker-search"
	| "ChannelsEmojiPicker-viewport";

const ChannelsEmojiPicker = memo(function ChannelsEmojiPicker(props: { onSelect: (emoji: string) => void }) {
	return (
		<EmojiPicker.Root
			className={"ChannelsEmojiPicker" satisfies ChannelsEmojiPicker_ClassNames}
			onEmojiSelect={({ emoji }) => props.onSelect(emoji)}
		>
			<EmojiPicker.Search
				aria-label="Find emoji"
				className={"ChannelsEmojiPicker-search" satisfies ChannelsEmojiPicker_ClassNames}
			/>
			<EmojiPicker.Viewport className={"ChannelsEmojiPicker-viewport" satisfies ChannelsEmojiPicker_ClassNames}>
				<EmojiPicker.Loading>Loading emoji…</EmojiPicker.Loading>
				<EmojiPicker.Empty>No emoji found</EmojiPicker.Empty>
				<EmojiPicker.List />
			</EmojiPicker.Viewport>
		</EmojiPicker.Root>
	);
});

export default ChannelsEmojiPicker;
