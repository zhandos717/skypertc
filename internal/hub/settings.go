package hub

import (
	"encoding/json"
	"os"
	"sync"
)

// Settings — настройки, которые приложение меняет на лету через /internal/settings.
type Settings struct {
	// MaxRoomPeers — сколько людей пускать в защищённую комнату (с секретом); запись разговора не считается, 0 — без ограничения.
	MaxRoomPeers int `json:"max_room_peers"`
}

type SettingsStore struct {
	mu   sync.RWMutex
	cur  Settings
	file string
}

// NewSettingsStore берёт значения по умолчанию, затем поверх них применяет сохранённый файл.
func NewSettingsStore(defaults Settings, file string) *SettingsStore {
	s := &SettingsStore{cur: defaults, file: file}
	if file != "" {
		if b, err := os.ReadFile(file); err == nil {
			var saved Settings
			if json.Unmarshal(b, &saved) == nil {
				s.cur = saved
			}
		}
	}
	return s
}

func (s *SettingsStore) Get() Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cur
}

func (s *SettingsStore) Set(next Settings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cur = next
	if s.file == "" {
		return nil
	}
	b, _ := json.Marshal(next)
	return os.WriteFile(s.file, b, 0o600)
}
