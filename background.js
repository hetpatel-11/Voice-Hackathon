chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'start-voice-shortcut') {
    return
  }

  await chrome.storage.session.set({ autoStartVoice: true })

  try {
    await chrome.action.openPopup()
  } catch {
    // If popup opening fails, leave the flag set so the next popup open auto-starts voice.
  }
})
