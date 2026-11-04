package hub

import (
	"path/filepath"
	"testing"
)

func TestSettingsPersistAndRoomPeopleSkipsRecorder(t *testing.T) {
	file := filepath.Join(t.TempDir(), "settings.json")

	s := NewSettingsStore(Settings{MaxRoomPeers: 2}, file)
	if s.Get().MaxRoomPeers != 2 {
		t.Fatalf("default not applied: %+v", s.Get())
	}
	if err := s.Set(Settings{MaxRoomPeers: 3}); err != nil {
		t.Fatal(err)
	}
	if got := NewSettingsStore(Settings{MaxRoomPeers: 2}, file).Get().MaxRoomPeers; got != 3 {
		t.Fatalf("saved value lost: %d", got)
	}

	room := &Room{Clients: map[string]*Client{"a": {}, "b": {}, "bot": {Recorder: true}}}
	if room.People() != 2 {
		t.Fatalf("recorder must not count, got %d", room.People())
	}
}
