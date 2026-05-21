package randutil

var randSeed uint64 = 0x9E3779B97F4A7C15

func randInt() int {
	randSeed ^= randSeed << 13
	randSeed ^= randSeed >> 7
	randSeed ^= randSeed << 17
	return int(randSeed & 0x7fffffff)
}

func RandID() string {
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 10)
	for i := range b {
		b[i] = letters[randInt()%len(letters)]
	}
	return string(b)
}
